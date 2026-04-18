// Parent-side client for the worker process. The MCP server never calls
// spawn("claude", …) or touches subprocess streams directly — it only asks
// this dispatcher to run a tool and awaits the reply over IPC.
//
// WHY: the MCP pipe to Claude Code lives in this parent process. Any stream
// error during a claude-CLI spawn happens inside the worker, not here. A worker
// crash surfaces here as a single 'exit' event — a well-defined channel the
// parent already has to handle — not an uncaughtException on the pipe-owner.

import { fork, type ChildProcess } from "node:child_process";

interface Pending {
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  tool: string;
}

// Grace window after a dmitry_task timeout: how long we keep the pending
// entry alive waiting for the worker's cancel-triggered partial-result reply.
// 5 s is enough for task.cancel() to SIGTERM the CLI, build the partial, and
// send it back over IPC; longer would just delay the eventual rejection.
const CANCEL_GRACE_MS = 5_000;

interface ResultMessage {
  id: string;
  kind: "result";
  ok: boolean;
  result?: string;
  error?: string;
}

interface ReadyMessage { kind: "ready" }

export class Dispatcher {
  private proc: ChildProcess | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private readyPromise: Promise<void> | null = null;

  constructor(private readonly workerPath: string) {}

  async run(tool: string, params: unknown, timeoutMs: number): Promise<string> {
    await this.ensureReady();
    const id = String(++this.seq);
    return new Promise<string>((resolve, reject) => {
      // Two-stage timeout for dmitry_task: at timeoutMs we send {kind:"cancel"}
      // to the worker (which resolves the subagent's active request with a
      // partial-result marker), then wait CANCEL_GRACE_MS for that reply before
      // giving up. For other tools, the timeout is a hard reject as before.
      const onTimeout = () => {
        if (tool === "dmitry_task") {
          try { this.proc?.send({ id, kind: "cancel", tool, timeout_ms: timeoutMs }); } catch { /* worker dead; grace timer still fires */ }
          const graceTimer = setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`${tool}: dispatcher timed out after ${timeoutMs}ms (cancel grace elapsed)`));
          }, CANCEL_GRACE_MS);
          const entry = this.pending.get(id);
          if (entry) entry.timer = graceTimer;
        } else {
          this.pending.delete(id);
          reject(new Error(`${tool}: dispatcher timed out after ${timeoutMs}ms`));
        }
      };
      const timer = setTimeout(onTimeout, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, tool });
      try {
        this.proc!.send({ id, kind: "call", tool, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`${tool}: IPC send failed: ${(err as Error).message}`));
      }
    });
  }

  kill(): void {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
  }

  private ensureReady(): Promise<void> {
    if (this.proc && this.readyPromise) return this.readyPromise;
    return this.spawnWorker();
  }

  private spawnWorker(): Promise<void> {
    // stdio: MCP server uses its own stdin/stdout for JSON-RPC — worker must NOT
    // inherit those or it would corrupt the protocol. Stderr inherited so worker
    // diagnostics reach Claude Code's MCP logs. 'ipc' channel is required for
    // process.send / .on("message").
    const child = fork(this.workerPath, [], {
      env: { ...process.env, DMITRY_WORKER: "1" },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    this.proc = child;

    this.readyPromise = new Promise<void>((resolve, reject) => {
      const onReady = (raw: unknown) => {
        const msg = raw as ReadyMessage;
        if (msg && msg.kind === "ready") {
          child.off("message", onReady);
          resolve();
        }
      };
      child.on("message", onReady);
      const earlyExit = () => reject(new Error("worker exited before ready"));
      child.once("exit", earlyExit);
      child.once("error", (err) => reject(new Error(`worker fork error: ${err.message}`)));
    });

    child.on("message", (raw: unknown) => {
      const msg = raw as ResultMessage;
      if (!msg || msg.kind !== "result") return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result ?? "");
      else p.reject(new Error(msg.error ?? "unknown worker error"));
    });

    child.on("exit", (code, signal) => {
      if (this.proc === child) {
        this.proc = null;
        this.readyPromise = null;
      }
      // Fail any in-flight calls so callers see a real error instead of hanging
      // until their timeout. Next run() call lazily respawns the worker.
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`${p.tool}: worker exited (${reason})`));
      }
      this.pending.clear();
    });

    child.on("error", (err) => {
      // 'error' is followed by 'exit' on spawn failure; exit handler cleans up
      // pending. Log to stderr so Claude Code's MCP log captures it.
      process.stderr.write(`[dmitry] worker error: ${err.message}\n`);
    });

    return this.readyPromise;
  }
}
