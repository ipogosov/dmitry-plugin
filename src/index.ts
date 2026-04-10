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
    "Run ANY shell command, get filtered output. This is your primary tool for ALL commands.",
    "Use for: grep, find, cat, git, cargo, npm, wc, ls, and any other command.",
    "RTK-covered commands (git, grep, cargo, npm, find, ls, cat, head) return instantly with zero LLM cost.",
    "Short output (<10 lines) returned as-is. Long output compressed by AI.",
    "ALWAYS prefer this for searches — grep via exec is free, research spawns an LLM.",
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
    "Send a DATA-GATHERING task to a persistent Haiku agent. It reads files, searches code, runs commands, and returns raw findings.",
    "It is your eyes and hands, not your brain. Do NOT delegate decisions, recommendations, or trade-off analysis.",
    "GOOD tasks: 'read src/auth/*.ts, return all public interfaces and their callers', 'find all usages of TokenManager'.",
    "BAD tasks: 'recommend the best approach for auth migration', 'analyze architecture and suggest improvements'.",
    "Context accumulates across calls — use for follow-up questions. Do NOT kill between tasks.",
    "One session at a time — calls are queued if another is in progress.",
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
    "Kill the persistent ask agent and clear its accumulated context. Use sparingly.",
    "Only use when: agent gives clearly wrong answers, repeats itself, or is stuck on stale context.",
    "Do NOT use between normal task switches — the agent handles unrelated topics fine within one session.",
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
    "Fetch a URL or search the web — returns clean page content (reader mode), not summaries.",
    "URL input: fetches page, strips HTML noise, returns readable text with links.",
    "Query input: searches the web, fetches top results, returns their clean content.",
    "Parallel-safe. Returns actual page content, not bullet-point summaries.",
  ].join(" "),
  {
    task: z.string().describe("URL to fetch or search query. English only."),
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
    "Process a document (PDF, DOCX, MD, image) and extract specific information. One-shot, parallel-safe.",
    "Use for: reading specs, extracting sections from large docs, analyzing images/screenshots, processing scientific papers.",
    "Returns: extracted content or summary — NOT the entire document.",
    "Provide file path or URL + what to extract.",
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
    "Run a test command and return only pass/fail + failure details. One-shot.",
    "Use for: npm test, cargo test, pytest, any test runner.",
    "Returns: pass/fail summary, failed test names, error messages. Drops passing tests and noise.",
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
    "Show Dmitry usage statistics: call counts, token consumption, and cost comparison (Haiku vs Sonnet vs Opus).",
    "Shows how much was saved by running tasks on Haiku instead of Opus/Sonnet.",
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
