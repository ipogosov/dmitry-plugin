import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { IS_WIN, buildRtkSettings, EMPTY_PLUGIN_DIR } from "./platform.js";
import { extractUsage, logHeartbeat, type Usage } from "./logger.js";

const RTK_SETTINGS = buildRtkSettings();

// Full code-mutation tool set. The subagent executes mechanical work delegated
// by parent Opus: mass edits, stubification, file moves, code extraction.
// Bash is included so the agent can verify its own changes (typecheck/build/test).
const TASK_TOOLS = "Read,Edit,Write,Grep,Glob,Bash";

// Disallow recursion into Dmitry's own tools and external archivists.
const DISALLOWED_TOOLS = [
  "mcp__dmitry__dmitry_exec",
  "mcp__dmitry__dmitry_ask",
  "mcp__dmitry__dmitry_ask_kill",
  "mcp__dmitry__dmitry_web",
  "mcp__dmitry__dmitry_doc",
  "mcp__dmitry__dmitry_test",
  "mcp__dmitry__dmitry_task",
  "mcp__hivemind__ask_archivist",
  "mcp__hivemind__report_to_archivist",
].join(",");

// Idle kill: match Anthropic's 5-minute prompt-cache TTL. Holding the process
// alive past cache expiry just burns RAM — the next call would cache-miss anyway.
const IDLE_KILL_MS = 5 * 60 * 1000;

const SYSTEM_PROMPT = [
  "You are Dmitry Task — a subagent spawned by Claude Opus to execute a delegated task.",
  "You have full code tools: Read, Edit, Write, Grep, Glob, Bash.",
  "",
  "ROLE: executor, not designer.",
  "- Do exactly what the task asks. Nothing more, nothing less.",
  "- No refactoring beyond the ask. No cleanup of adjacent code.",
  "- No new features, no scope expansion. No 'while I'm here' changes.",
  "- If the task is genuinely ambiguous about scope, ask ONE clarifying question and STOP. Do not guess.",
  "- Only Write/Edit files explicitly named or logically implied by the task.",
  "- Never touch paths under ~/.claude/ or ~/.dmitry/.",
  "",
  "FILE FRESHNESS: trust the session cache, re-Read only when staleness is plausible.",
  "- If you already Read a file this session and nothing since then could have changed it, skip the re-Read and Edit directly.",
  "- Re-Read before Edit ONLY when: (a) a Bash command, git operation, or another actor may have touched the file since your last Read, or (b) more than ~10 turns have passed since your last Read.",
  "- If Edit fails because the expected content is gone, STOP and report the mismatch — do not improvise or merge.",
  "",
  "VERIFY YOUR WORK:",
  "- After any code change, run the project's verification and include the result in your report.",
  "- Default order when the task doesn't specify: typecheck → build → test. Pick whichever exists, stop at the first that gives a meaningful signal.",
  "- If CLAUDE.md at the project root specifies verification commands, use those instead.",
  "- If verification fails AND the failure was caused by your change: fix it. That's in scope.",
  "- If verification fails AND the failure existed before your change: report it, do NOT fix it.",
  "- Do NOT run unrelated commands (cleanup scripts, deploys, formatters the task didn't ask for).",
  "",
  "CONTEXT: persistent session — context accumulates across calls.",
  "- If you already read a file this session and it's unchanged, reference it instead of re-dumping.",
  "- If you need project conventions, read CLAUDE.md at the project root once.",
  "",
  "OUTPUT:",
  "- Return a compact diff summary (files changed, lines added/removed), not new file bodies.",
  "- Include verification result: typecheck/build/test PASS or FAIL with key errors.",
  "- For investigations (no edits): findings with file:line cites.",
  "- Plain text. No markdown. No backticks, no ``` blocks, no **, no ##, no | tables. English only. No preamble.",
  "",
  "CRITICAL: never write memory files. Never use the Write tool on any path under ~/.claude/.",
].join("\n");

export type TaskModel = "haiku" | "sonnet" | "opus";

export interface TaskResult {
  result: string;
  usage: Usage | null;
  model_switched: boolean;
}

interface PendingRequest {
  message: string;
  model: TaskModel;
  context1M: boolean;
  resolve: (value: TaskResult) => void;
  reject: (reason: Error) => void;
}

export class TaskManager {
  private proc: ChildProcess | null = null;
  private currentModel: TaskModel | null = null;
  private currentContext1M = false;
  private buffer = "";
  private busy = false;
  private queue: PendingRequest[] = [];
  private activeRequest: { resolve: (v: TaskResult) => void; reject: (e: Error) => void; modelSwitched: boolean } | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private turnCount = 0;
  private lastActivity = "";

  async send(message: string, model: TaskModel, context1M = false): Promise<TaskResult> {
    return new Promise<TaskResult>((resolve, reject) => {
      this.queue.push({ message, model, context1M, resolve, reject });
      this.drain();
    });
  }

  kill(reason = "manual kill"): void {
    this.clearIdleTimer();
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
      this.currentModel = null;
      this.currentContext1M = false;
      this.buffer = "";
      this.busy = false;
      if (this.activeRequest) {
        this.activeRequest.reject(new Error(`Task process killed: ${reason}`));
        this.activeRequest = null;
      }
      for (const { reject } of this.queue) {
        reject(new Error(`Task process killed: ${reason}`));
      }
      this.queue = [];
    }
  }

  isAlive(): boolean {
    return this.proc !== null;
  }

  // Dispatcher-side timeout cancellation. Unlike kill(), resolves the active
  // request with a partial-result marker so the caller can still see what the
  // subagent did (files on disk, commits made) before the cancel landed.
  // Returns true if there was an active request to cancel.
  cancel(timeoutMs: number): boolean {
    if (!this.activeRequest) return false;
    const partial = [
      `[DMITRY_TIMEOUT after ${timeoutMs}ms — partial result, subagent killed]`,
      `Turns completed: ${this.turnCount}`,
      `Last activity: ${this.lastActivity || "(no assistant turns yet)"}`,
      "Files written and commits made before this point are on disk — verify via git log / filesystem before redispatching.",
    ].join("\n");
    const req = this.activeRequest;
    this.activeRequest = null;
    req.resolve({ result: partial, usage: null, model_switched: req.modelSwitched });
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
      this.currentModel = null;
      this.currentContext1M = false;
      this.buffer = "";
      this.busy = false;
      this.clearIdleTimer();
    }
    // Keep queue intact: any follow-up caller gets a fresh process via drain().
    this.drain();
    return true;
  }

  currentModelName(): TaskModel | null {
    return this.currentModel;
  }

  private drain(): void {
    if (this.busy || this.queue.length === 0) return;

    const req = this.queue[0];
    let modelSwitched = false;

    // Model OR context-size change — kill existing instance, respawn.
    // WHY shift before kill: kill() iterates and rejects every queued request.
    // If req is still in queue when kill runs, its promise is settled as
    // rejected, and the later activeRequest.resolve() on the result is a no-op.
    const needsRespawn =
      this.proc !== null &&
      (this.currentModel !== req.model || this.currentContext1M !== req.context1M);
    if (needsRespawn) {
      this.queue.shift();
      const reason = this.currentModel !== req.model
        ? `model switch ${this.currentModel} → ${req.model}`
        : `context switch ${this.currentContext1M ? "1m" : "200k"} → ${req.context1M ? "1m" : "200k"}`;
      this.kill(reason);
      this.queue.unshift(req);
      modelSwitched = true;
    }

    this.clearIdleTimer();
    if (!this.proc) this.spawnCli(req.model, req.context1M);

    this.busy = true;
    this.queue.shift();
    this.activeRequest = { resolve: req.resolve, reject: req.reject, modelSwitched };

    const input =
      JSON.stringify({
        type: "user",
        message: { role: "user", content: req.message },
      }) + "\n";

    try {
      this.proc!.stdin!.write(input);
    } catch (err) {
      if (this.activeRequest) {
        this.activeRequest.reject(new Error(`Task stdin write failed: ${(err as Error).message}`));
        this.activeRequest = null;
      }
      this.busy = false;
    }
  }

  private spawnCli(model: TaskModel, context1M: boolean): void {
    // 1M context window. Opus 4.7, Opus 4.6, and Sonnet 4.6 support it via the
    // [1m] alias suffix. Haiku has no 1M variant. Default is 200k: 1M Sonnet
    // costs extra on most plans and only pays off for long plans / large specs.
    // Caller opts in per-dispatch with context_1m:true; env DMITRY_TASK_1M_CONTEXT=1
    // forces it on globally for operators who prefer the old default.
    const force1M = process.env.DMITRY_TASK_1M_CONTEXT === "1";
    const wants1M = model !== "haiku" && (context1M || force1M);
    const modelArg = wants1M ? `${model}[1m]` : model;
    const child = spawn(
      "claude",
      [
        "--model", modelArg,
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
        "--setting-sources", "",
        "--settings", RTK_SETTINGS,
        "--plugin-dir", EMPTY_PLUGIN_DIR,
        "--tools", TASK_TOOLS,
        "--disallowed-tools", DISALLOWED_TOOLS,
        "--disable-slash-commands",
        "--add-dir", process.cwd(),
        "--add-dir", join(homedir(), "Work"),
        "--append-system-prompt", SYSTEM_PROMPT,
        "--allowedTools", TASK_TOOLS,
        // Without this, Edit/Write/Bash hang waiting for an interactive
        // permission prompt that stream-json stdin cannot answer. Scope is
        // already constrained by --tools/--disallowed-tools/--add-dir and the
        // system-prompt rules (no writes under ~/.claude or ~/.dmitry).
        "--permission-mode", "bypassPermissions",
      ],
      {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, DMITRY_INTERNAL: "1" },
        ...(IS_WIN && { shell: true }),
      },
    );

    this.proc = child;
    this.currentModel = model;
    this.currentContext1M = wants1M;
    this.turnCount = 0;
    this.lastActivity = "";

    child.stdout!.on("data", (chunk: Buffer) => {
      this.handleData(chunk.toString());
    });
    child.stdout!.on("error", () => { /* handled via 'exit' */ });

    // WHY: stderr must be drained or the pipe buffer fills and the child blocks.
    child.stderr!.on("data", () => {});
    child.stderr!.on("error", () => {});

    // WHY: unhandled 'error' on stdin = uncaughtException = dead process.
    child.stdin!.on("error", () => { /* child exit will handle rejection */ });

    child.on("exit", (code) => {
      if (this.proc === child) {
        this.proc = null;
        this.currentModel = null;
        this.currentContext1M = false;
        this.buffer = "";
        this.busy = false;
        this.clearIdleTimer();
        if (this.activeRequest) {
          this.activeRequest.reject(new Error(`Task process exited with code ${code}`));
          this.activeRequest = null;
        }
        this.drain();
      }
    });

    child.on("error", (err) => {
      if (this.proc === child) {
        this.proc = null;
        this.currentModel = null;
        this.clearIdleTimer();
        if (this.activeRequest) {
          this.activeRequest.reject(new Error(`Task process error: ${err.message}`));
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
    // Heartbeat: one line per assistant turn to worker stderr. Visible in
    // Claude Code's MCP log so the operator can see the task is alive during
    // multi-minute runs without any round-trip to the parent.
    if (msg.type === "assistant") {
      this.turnCount++;
      const message = msg.message as { content?: Array<Record<string, unknown>> } | undefined;
      const blocks = message?.content ?? [];
      const toolNames = blocks
        .filter((b) => b.type === "tool_use" && typeof b.name === "string")
        .map((b) => b.name as string);
      const textLen = blocks
        .filter((b) => b.type === "text")
        .reduce((a, b) => a + (typeof b.text === "string" ? (b.text as string).length : 0), 0);
      const summary = toolNames.length > 0 ? `tool=${toolNames.join(",")}` : `text=${textLen}ch`;
      const model = this.currentModel ?? "?";
      this.lastActivity = `turn ${this.turnCount} ${summary}`;
      process.stderr.write(`[dmitry.task] turn ${this.turnCount} model=${model} ${summary}\n`);
      logHeartbeat({
        ts: new Date().toISOString(),
        turn: this.turnCount,
        model,
        summary,
      });
      return;
    }

    if (msg.type !== "result") return;

    if (msg.subtype === "success") {
      if (this.activeRequest) {
        this.activeRequest.resolve({
          result: (msg.result as string) || "",
          usage: extractUsage(msg),
          model_switched: this.activeRequest.modelSwitched,
        });
        this.activeRequest = null;
      }
      this.busy = false;
      this.scheduleIdleKill();
      this.drain();
    }

    if (msg.subtype === "error") {
      if (this.activeRequest) {
        this.activeRequest.reject(
          new Error(`Task error: ${(msg as Record<string, unknown>).error || "unknown"}`),
        );
        this.activeRequest = null;
      }
      this.busy = false;
      this.scheduleIdleKill();
      this.drain();
    }
  }

  private scheduleIdleKill(): void {
    this.clearIdleTimer();
    // Only arm the timer if the queue is drained — otherwise the next call
    // will fire immediately and we don't want to kill mid-turn.
    if (this.queue.length === 0) {
      this.idleTimer = setTimeout(() => {
        if (!this.busy && this.queue.length === 0) {
          this.kill("idle 5min");
        }
      }, IDLE_KILL_MS);
      this.idleTimer.unref?.();
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
