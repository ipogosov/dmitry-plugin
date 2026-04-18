// Dmitry MCP server — entry point for BOTH processes.
//
// The same bundle is used in two modes, selected by env var:
//   DMITRY_WORKER=1 → worker mode (src/worker.ts — owns claude-CLI lifecycle).
//   unset          → server mode (this file below — owns the MCP JSON-RPC pipe).
//
// WHY one bundle, two modes: lets `fork(process.argv[1], ...)` re-enter the
// same binary with no extra build step or path plumbing. Dead-code for the
// other mode stays inert — neither side executes the other's setup.

if (process.env.DMITRY_WORKER === "1") {
  // Worker mode: let the worker module's top-level code run and take over.
  await import("./worker.js");
} else {
  await runServer();
}

async function runServer(): Promise<void> {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { z } = await import("zod");
  const { Dispatcher } = await import("./dispatcher.js");
  const { IS_WIN } = await import("./platform.js");
  const { computeStats } = await import("./stats.js");
  const { log } = await import("./logger.js");

  // Safety net. If anything reaches this handler it is already a bug — the
  // dispatcher is supposed to absorb every handler error — but we keep the
  // MCP pipe alive rather than letting the process die.
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
    process.stderr.write(`[dmitry server] unhandledRejection: ${msg}\n`);
    log({ ts: new Date().toISOString(), tool: "dmitry_exec", input: "<server>", route: "short", input_len: 0, output_len: 0, duration_ms: 0, error: `unhandledRejection: ${msg}` });
  });
  process.on("uncaughtException", (err) => {
    process.stderr.write(`[dmitry server] uncaughtException: ${err.stack || err.message}\n`);
    log({ ts: new Date().toISOString(), tool: "dmitry_exec", input: "<server>", route: "short", input_len: 0, output_len: 0, duration_ms: 0, error: `uncaughtException: ${err.stack || err.message}` });
  });

  const dispatcher = new Dispatcher(process.argv[1]!);

  const server = new McpServer({ name: "dmitry", version: "0.2.0" });

  // Per-tool dispatcher timeouts. Upper bound on how long the parent waits
  // for a worker reply. Worker-internal timeouts (oneshot, execCommand) run
  // tighter; these are a safety net in case the worker freezes without crashing.
  const TIMEOUT_EXEC  = 120_000;
  const TIMEOUT_ASK   = 600_000;
  const TIMEOUT_WEB   = 300_000;
  const TIMEOUT_DOC   = 300_000;
  const TIMEOUT_TEST  = 180_000;
  const TIMEOUT_TASK  = 900_000;
  // Per-dispatch ceiling for dmitry_task. Writing-plans expansions and bundled
  // multi-task dispatches can legitimately run 20–30 min; 15 min cut them off.
  const TIMEOUT_TASK_MAX = 1_800_000;
  const TIMEOUT_TASK_MIN = 60_000;

  // Thin adapter: every tool is `dispatcher.run(name, params, timeout)`.
  // Error path: dispatcher rejects → we return a text error to the MCP client.
  // The pipe stays open regardless of what happened inside the worker.
  const wrap = (tool: string, timeoutMs: number) => async (params: Record<string, unknown>) => {
    try {
      const result = await dispatcher.run(tool, params, timeoutMs);
      return { content: [{ type: "text" as const, text: result }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
    }
  };

  server.tool(
    "dmitry_exec",
    [
      "Run ANY shell command, get filtered output. PRIMARY tool for ALL commands:",
      "grep, find, cat, git, cargo, npm, wc, ls, etc.",
      "RTK-covered (git, grep, cargo, npm, find, ls, cat, head) → instant, 0 LLM cost.",
      "Short output (<10 lines) as-is. Long output AI-compressed.",
      "ALWAYS prefer for searches — exec grep is free, research spawns LLM.",
    ].join(" "),
    {
      command: z.string().describe("Bash command to execute"),
      timeout: z.number().optional().describe("Timeout in ms (default: 60000)"),
    },
    wrap("dmitry_exec", TIMEOUT_EXEC),
  );

  server.tool(
    "dmitry_ask",
    [
      "DATA-GATHERING task to persistent Haiku agent. Reads files, searches code, runs commands, returns raw findings.",
      "Your eyes and hands, NOT your brain. NEVER delegate decisions, recommendations, trade-off analysis.",
      "GOOD: 'read src/auth/*.ts, return public interfaces + callers', 'find all usages of TokenManager'.",
      "BAD: 'recommend best auth migration approach', 'analyze architecture, suggest improvements'.",
      "Context accumulates across calls — use for follow-ups. Do NOT kill between tasks.",
      "Single session — concurrent calls queued.",
    ].join(" "),
    {
      task: z.string().describe("Data-gathering task or follow-up question. English only."),
    },
    wrap("dmitry_ask", TIMEOUT_ASK),
  );

  server.tool(
    "dmitry_ask_kill",
    [
      "Kill persistent ask agent + clear context. Use SPARINGLY.",
      "Only when: wrong answers, repetition, stuck on stale context.",
      "NOT between normal task switches — agent handles unrelated topics fine in one session.",
    ].join(" "),
    {},
    wrap("dmitry_ask_kill", 10_000),
  );

  server.tool(
    "dmitry_web",
    [
      "Web research scout — multi-step exploration when you don't know which page has the answer.",
      "Runs search/fetch loop, follows links, returns INVENTORY (URL + kind + headings + literal excerpt).",
      "Does NOT judge relevance — you read the inventory, pick what to fetch in full.",
      "Use for: 2+ searches, topic surveys, 'find sources on X'.",
      "Single known URL or keyword lookup → use WebFetch/WebSearch directly.",
      "Parallel-safe.",
    ].join(" "),
    {
      task: z.string().describe("Research task — what to discover. Dmitry returns an inventory of pages, not an answer. English only."),
    },
    wrap("dmitry_web", TIMEOUT_WEB),
  );

  server.tool(
    "dmitry_doc",
    [
      "Extract specific info from a document (PDF, DOCX, MD, image). One-shot, parallel-safe.",
      "Use for: specs, sections from large docs, images/screenshots, scientific papers.",
      "Returns extracted content/summary — NOT the entire document.",
      "Input: file path or URL + what to extract.",
    ].join(" "),
    {
      task: z.string().describe("File path or URL + what to extract. English only."),
    },
    wrap("dmitry_doc", TIMEOUT_DOC),
  );

  server.tool(
    "dmitry_test",
    [
      "Run test command, return pass/fail + failure details. One-shot.",
      "Use for: npm test, cargo test, pytest, any test runner.",
      "Returns: pass/fail summary, failed test names, error messages. Drops passing tests + noise.",
    ].join(" "),
    {
      command: z.string().describe("Test command to run (e.g. 'npm test', 'cargo test')"),
      timeout: z.number().optional().describe("Timeout in ms (default: 120000)"),
    },
    wrap("dmitry_test", TIMEOUT_TEST),
  );

  server.tool(
    "dmitry_task",
    "Persistent subagent (Sonnet default). Replaces native Task/Agent. Full code tools + self-verifies. Context accumulates; idle >5min auto-kill. Pass kill:true to reset early. Pass model=opus only for novel design/debug. Pass timeout_ms to extend the default 15-min ceiling up to 30 min for large writing-plans or bundled tasks.",
    {
      task: z.string().optional().describe("Task for the subagent. English only. Omit when kill=true."),
      model: z.enum(["haiku", "sonnet", "opus"]).optional().describe("Model tier (default: sonnet)."),
      kill: z.boolean().optional().describe("If true, kill the subagent and clear its context. Ignores task/model."),
      timeout_ms: z.number().int().min(TIMEOUT_TASK_MIN).max(TIMEOUT_TASK_MAX).optional().describe("Per-dispatch timeout in ms. Default 900000 (15 min), max 1800000 (30 min). Raise for writing-plans expansions or multi-task bundles."),
      context_1m: z.boolean().optional().describe("Use 1M context window (Sonnet/Opus only). Default false (200k). Enable for long plans, large specs, or multi-file investigations; leave off for short mechanical tasks to save cost. Env DMITRY_TASK_1M_CONTEXT=1 forces it on globally."),
    },
    async (params) => {
      const requested = params.timeout_ms as number | undefined;
      const timeoutMs = requested ?? TIMEOUT_TASK;
      try {
        const result = await dispatcher.run("dmitry_task", params, timeoutMs);
        return { content: [{ type: "text" as const, text: result }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
      }
    },
  );

  server.tool(
    "dmitry_stats",
    [
      "Dmitry usage stats: call counts, token consumption, cost comparison (Haiku vs Sonnet vs Opus).",
      "Shows savings from running tasks on Haiku instead of Opus/Sonnet.",
    ].join(" "),
    {
      period: z.enum(["today", "week", "all"]).optional().describe("Time period (default: today)"),
    },
    async ({ period }) => {
      // stats reads the JSONL log files on disk — no subprocess, no worker round-trip.
      const result = computeStats(period ?? "today");
      return { content: [{ type: "text" as const, text: result }] };
    },
  );

  const shutdown = () => { dispatcher.kill(); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  if (IS_WIN) process.on("SIGBREAK", shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
