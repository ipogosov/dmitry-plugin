import { spawn } from "node:child_process";
import { IS_WIN, buildRtkSettings, EMPTY_PLUGIN_DIR } from "./platform.js";
import { extractUsage, type Usage } from "./logger.js";

const RTK_SETTINGS = buildRtkSettings();

const DISALLOWED_TOOLS = [
  "mcp__dmitry__dmitry_exec",
  "mcp__dmitry__dmitry_ask",
  "mcp__dmitry__dmitry_ask_kill",
  "mcp__dmitry__dmitry_web",
  "mcp__dmitry__dmitry_doc",
  "mcp__dmitry__dmitry_test",
  "mcp__hivemind__ask_archivist",
  "mcp__hivemind__report_to_archivist",
].join(",");

const SYSTEM_PROMPT = [
  "You are a CLI data tool. Your output is consumed by Claude Opus (another LLM), not a human.",
  "Respond like grep, ripgrep, or find would: raw results, no decoration.",
  "",
  "Example task: find where handle_message is called",
  "Example output:",
  "src/sync.rs:134  mgr.handle_message(event, room)",
  "src/bridge.rs:89  self.handle_message(msg)",
  "sig: async fn handle_message(&self, event: Event, room: Room)",
  "",
  "OVERRIDE default formatting: your output is consumed by another LLM, NOT rendered for a human.",
  "Do NOT use GitHub-flavored markdown unless the task explicitly asks for it.",
  "No backticks, no ``` blocks, no **, no ##, no | tables, no bullet lists.",
  "No preamble, no explanation, no commentary. Start directly with the data. English only.",
  "For multi-step tasks: follow the trail, return final result only.",
  "",
  "If a file has any line >2000 chars, it is likely minified/generated.",
  "Do not read it in one call — spawn a subagent to process it in chunks",
  "and return a summary. If the task does not require this file's content,",
  "skip it and note 'skipped: likely minified/generated'.",
  "",
  "If the task requires understanding project architecture or conventions,",
  "read CLAUDE.md at the project root first.",
  "",
  "CRITICAL: Never write memory files. Never use the Write tool on any path under ~/.claude/.",
  "You are a tool, not an assistant. Do not save anything to memory.",
].join("\n");

export interface OneshotResult {
  result: string;
  usage: Usage | null;
}

export interface OneshotOptions {
  timeout?: number;
  systemPrompt?: string;
  // Comma-separated whitelist of built-in tools. Pass "" for pure text filter
  // (exec/test) to drop all tool schemas from the prefix (~12k tokens).
  tools?: string;
  // If true, replace Claude Code's default system prompt entirely via --system-prompt
  // (instead of appending to it). Drops another ~6k tokens but loses CC's built-in
  // tool-use protocol, so only safe for roles that pass tools="" (pure text filters).
  replaceSystemPrompt?: boolean;
}

export function oneshot(task: string, opts: OneshotOptions | number = {}): Promise<OneshotResult> {
  const { timeout = 180_000, systemPrompt = SYSTEM_PROMPT, tools = "", replaceSystemPrompt = false } =
    typeof opts === "number" ? { timeout: opts } : opts;
  const sysFlag = replaceSystemPrompt ? "--system-prompt" : "--append-system-prompt";

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const child = spawn(
      "claude",
      [
        "--print",
        "--output-format", "stream-json",
        "--model", "haiku",
        "--setting-sources", "",
        "--settings", RTK_SETTINGS,
        "--plugin-dir", EMPTY_PLUGIN_DIR,
        "--tools", tools,
        "--disallowed-tools", DISALLOWED_TOOLS,
        "--disable-slash-commands",
        "--add-dir", process.cwd(),
        ...(process.env.DMITRY_WORK_DIR ? ["--add-dir", process.env.DMITRY_WORK_DIR] : []),
        sysFlag, systemPrompt,
        "--verbose",
        "--allowedTools", tools,
      ],
      {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        ...(IS_WIN && { shell: true }),
      },
    );

    child.stdout!.on("data", (chunk: Buffer) => chunks.push(chunk));

    child.on("error", (err) => reject(new Error(`Oneshot spawn error: ${err.message}`)));

    child.on("exit", (code) => {
      const output = Buffer.concat(chunks).toString().trim();
      const lines = output.split("\n");

      // Find the result message with usage
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const msg = JSON.parse(lines[i]);
          if (msg.type === "result") {
            if (msg.subtype === "success") {
              resolve({ result: (msg.result as string) || "", usage: extractUsage(msg) });
            } else {
              reject(new Error(msg.error || `Oneshot exited with code ${code}`));
            }
            return;
          }
        } catch { /* not JSON */ }
      }

      // No result message found — fallback
      if (code !== 0) {
        reject(new Error(output || `Oneshot exited with code ${code}`));
      } else {
        resolve({ result: output, usage: null });
      }
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Oneshot timed out after ${timeout}ms`));
    }, timeout);

    child.on("exit", () => clearTimeout(timer));

    child.stdin!.write(task);
    child.stdin!.end();
  });
}
