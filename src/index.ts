import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CliManager } from "./cli-manager.js";
import { handleExec, handleAsk, handleAskKill, handleWeb, handleDoc, handleTest } from "./tools.js";
import { log } from "./logger.js";
import { IS_WIN } from "./platform.js";
import { computeStats } from "./stats.js";

const cli = new CliManager();

const server = new McpServer({
  name: "dmitry",
  version: "0.2.0",
});

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
  async ({ command, timeout }) => {
    const start = Date.now();
    try {
      const result = await handleExec({ command, timeout });
      return { content: [{ type: "text" as const, text: result }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log({ ts: new Date().toISOString(), tool: "dmitry_exec", input: command, route: "short", input_len: command.length, output_len: msg.length, duration_ms: Date.now() - start, error: msg });
      return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
    }
  },
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
  async ({ task }) => {
    const start = Date.now();
    try {
      const result = await handleAsk(cli, { task });
      return { content: [{ type: "text" as const, text: result }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log({ ts: new Date().toISOString(), tool: "dmitry_ask", input: task, route: "haiku", input_len: task.length, output_len: msg.length, duration_ms: Date.now() - start, error: msg });
      return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
    }
  },
);

server.tool(
  "dmitry_ask_kill",
  [
    "Kill persistent ask agent + clear context. Use SPARINGLY.",
    "Only when: wrong answers, repetition, stuck on stale context.",
    "NOT between normal task switches — agent handles unrelated topics fine in one session.",
  ].join(" "),
  {},
  async () => {
    const result = handleAskKill(cli);
    return { content: [{ type: "text" as const, text: result }] };
  },
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
  async ({ task }) => {
    const start = Date.now();
    try {
      const result = await handleWeb({ task });
      return { content: [{ type: "text" as const, text: result }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log({ ts: new Date().toISOString(), tool: "dmitry_web", input: task, route: "haiku", input_len: task.length, output_len: msg.length, duration_ms: Date.now() - start, error: msg });
      return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
    }
  },
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
  async ({ task }) => {
    const start = Date.now();
    try {
      const result = await handleDoc({ task });
      return { content: [{ type: "text" as const, text: result }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log({ ts: new Date().toISOString(), tool: "dmitry_doc", input: task, route: "haiku", input_len: task.length, output_len: msg.length, duration_ms: Date.now() - start, error: msg });
      return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
    }
  },
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
  async ({ command, timeout }) => {
    const start = Date.now();
    try {
      const result = await handleTest({ command, timeout });
      return { content: [{ type: "text" as const, text: result }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log({ ts: new Date().toISOString(), tool: "dmitry_test", input: command, route: "short", input_len: command.length, output_len: msg.length, duration_ms: Date.now() - start, error: msg });
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
    const result = computeStats(period ?? "today");
    return { content: [{ type: "text" as const, text: result }] };
  },
);

process.on("SIGTERM", () => cli.kill());
process.on("SIGINT", () => cli.kill());
if (IS_WIN) process.on("SIGBREAK", () => cli.kill());

const transport = new StdioServerTransport();
await server.connect(transport);
