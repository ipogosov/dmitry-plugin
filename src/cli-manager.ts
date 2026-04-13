import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { IS_WIN, buildRtkSettings, EMPTY_PLUGIN_DIR } from "./platform.js";
import { extractUsage, type Usage } from "./logger.js";

const RTK_SETTINGS = buildRtkSettings();

// Minimal tool set for data gathering: read files, search, run commands.
// Web research belongs in dmitry_web; nested Agent spawns are disallowed on purpose.
const ASK_TOOLS = "Read,Grep,Glob,Bash";

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
  "You are Dmitry — a data-gathering agent. You read files, search code, run commands, and return raw findings.",
  "Your output is consumed by a stronger model (Opus/Sonnet), not a human.",
  "You run for the entire session — context accumulates across all calls. Use it.",
  "",
  "YOUR ROLE: eyes and hands, not brain.",
  "- DO: read files, grep code, trace imports, list interfaces, run tests, fetch pages.",
  "- DO: organize findings clearly — what you found, where, exact content.",
  "- DO NOT: make architectural decisions, recommend approaches, analyze trade-offs.",
  "- DO NOT: answer 'what should we do' questions. Instead, gather the data the caller needs to decide.",
  "- If a task asks you to 'recommend' or 'decide', reframe it as data gathering: find the options, list pros/cons as facts, return.",
  "- If the task is vague or ambiguous, ask ONE clarifying question instead of guessing scope.",
  "",
  "Context rules:",
  "- If you already read a file earlier in this conversation, reference it directly.",
  "- Use the Read tool (not Bash cat) for files — it auto-detects unchanged files.",
  "- If you need project conventions, read CLAUDE.md at the project root.",
  "",
  "Tool budget:",
  "- Aim for at most 25 tool calls per task. Stop when you have enough to answer, even if you could look further.",
  "- If the task genuinely requires more (broad survey, exhaustive search), continue — this is a soft ceiling, not a hard limit.",
  "",
  "Response rules:",
  "- Return findings, not conclusions. Return ALL findings — do not summarize for brevity. The caller wants completeness, not concision.",
  "- Cite file:line for every concrete claim. If you state that X happens in auth middleware, say WHERE in auth middleware.",
  "- Before returning your final message, re-read your draft and ensure every concrete claim has a file:line cite. Fix missing ones.",
  "- Plain text only. OVERRIDE: do NOT use GitHub-flavored markdown.",
  "- No backticks, no ``` blocks, no **, no ##, no | tables, no bullet lists.",
  "- No preamble. Start directly with the data. English only.",
  "",
  "If a file has any line >2000 chars, it is likely minified/generated.",
  "Skip and note 'skipped: likely minified/generated'.",
  "",
  "CRITICAL: Never write memory files. Never use the Write tool on any path under ~/.claude/.",
].join("\n");

export interface CliResult {
  result: string;
  usage: Usage | null;
}

interface PendingRequest {
  message: string;
  resolve: (value: CliResult) => void;
  reject: (reason: Error) => void;
}

export class CliManager {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private busy = false;
  private queue: PendingRequest[] = [];
  private activeRequest: { resolve: (v: CliResult) => void; reject: (e: Error) => void } | null = null;

  async send(message: string): Promise<CliResult> {
    return new Promise<CliResult>((resolve, reject) => {
      this.queue.push({ message, resolve, reject });
      this.drain();
    });
  }

  kill(): void {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
      this.buffer = "";
      this.busy = false;
      if (this.activeRequest) {
        this.activeRequest.reject(new Error("CLI process killed"));
        this.activeRequest = null;
      }
      for (const { reject } of this.queue) {
        reject(new Error("CLI process killed"));
      }
      this.queue = [];
    }
  }

  isAlive(): boolean {
    return this.proc !== null;
  }

  private drain(): void {
    if (this.busy || this.queue.length === 0) return;

    if (!this.proc) this.spawnCli();

    this.busy = true;
    const req = this.queue.shift()!;
    this.activeRequest = { resolve: req.resolve, reject: req.reject };

    const input =
      JSON.stringify({
        type: "user",
        message: { role: "user", content: req.message },
      }) + "\n";

    this.proc!.stdin!.write(input);
  }

  private spawnCli(): void {
    const child = spawn(
      "claude",
      [
        "--model",
        "haiku",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--setting-sources", "",
        "--settings", RTK_SETTINGS,
        "--plugin-dir", EMPTY_PLUGIN_DIR,
        "--tools", ASK_TOOLS,
        "--disallowed-tools", DISALLOWED_TOOLS,
        "--disable-slash-commands",
        "--add-dir", process.cwd(),
        "--add-dir", join(homedir(), "Work"),
        "--append-system-prompt",
        SYSTEM_PROMPT,
        "--allowedTools", ASK_TOOLS,
      ],
      {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, DMITRY_INTERNAL: "1" },
        ...(IS_WIN && { shell: true }),
      },
    );

    this.proc = child;

    child.stdout!.on("data", (chunk: Buffer) => {
      this.handleData(chunk.toString());
    });

    child.on("exit", (code) => {
      if (this.proc === child) {
        this.proc = null;
        this.buffer = "";
        this.busy = false;
        if (this.activeRequest) {
          this.activeRequest.reject(new Error(`CLI process exited with code ${code}`));
          this.activeRequest = null;
        }
        this.drain();
      }
    });

    child.on("error", (err) => {
      if (this.proc === child) {
        this.proc = null;
        if (this.activeRequest) {
          this.activeRequest.reject(new Error(`CLI process error: ${err.message}`));
          this.activeRequest = null;
        }
        this.busy = false;
      }
    });
  }

  private handleData(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        this.handleMessage(parsed);
      } catch {
        // Not JSON, skip
      }
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    if (msg.type !== "result") return;

    if (msg.subtype === "success") {
      if (this.activeRequest) {
        this.activeRequest.resolve({
          result: (msg.result as string) || "",
          usage: extractUsage(msg),
        });
        this.activeRequest = null;
      }
      this.busy = false;
      this.drain();
    }

    if (msg.subtype === "error") {
      if (this.activeRequest) {
        this.activeRequest.reject(
          new Error(`Haiku error: ${(msg as Record<string, unknown>).error || "unknown"}`),
        );
        this.activeRequest = null;
      }
      this.busy = false;
      this.drain();
    }
  }
}
