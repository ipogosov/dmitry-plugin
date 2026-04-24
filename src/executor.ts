import { spawn } from "node:child_process";
import { shellArgs } from "./platform.js";
import { IS_WIN } from "./platform.js";

// Idle watchdog default: 3 min of zero stdout/stderr → SIGTERM. Catches
// silently-stuck processes without lying about cases where output streams
// (downloads, builds, agents). Override via DMITRY_EXEC_IDLE_MS; 0 disables.
const DEFAULT_IDLE_MS = (() => {
  const raw = process.env.DMITRY_EXEC_IDLE_MS;
  if (raw === undefined) return 180_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 180_000;
})();

const MAX_BUFFER = 10 * 1024 * 1024;
const SIGKILL_GRACE_MS = 2_000;

export interface ExecKilled {
  reason: "idle" | "wall-clock";
  afterMs: number;
}

export interface ExecResult {
  output: string;
  exitCode: number;
  killed: ExecKilled | null;
}

export interface ExecOptions {
  timeout?: number;   // hard wall-clock cap, default 60_000
  idleMs?: number;    // idle watchdog, default DEFAULT_IDLE_MS, 0 disables
}

export function execCommand(
  command: string,
  options: number | ExecOptions = {},
): Promise<ExecResult> {
  // Back-compat: callers may still pass a bare timeout number.
  const opts: ExecOptions = typeof options === "number" ? { timeout: options } : options;
  const timeoutMs = opts.timeout ?? 60_000;
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const [shell, args] = shellArgs(command);
    // detached: true on POSIX makes the child a process-group leader. Lets us
    // signal the entire tree (bash + its forks like sleep/git/npm) by killing
    // -pid. Without this, SIGTERM goes only to bash and orphans like `sleep 30`
    // hold the stdout pipe open until natural completion — defeating idle-kill.
    const child = spawn(shell, args, { cwd: process.cwd(), detached: !IS_WIN });

    let stdout = "";
    let stderr = "";
    let bytesBuffered = 0;
    let truncated = false;
    let killed: ExecKilled | null = null;

    const killGroup = (signal: "SIGTERM" | "SIGKILL") => {
      if (IS_WIN) {
        try { child.kill(signal); } catch { /* gone */ }
        return;
      }
      // Negative pid = signal the whole process group (see spawn detached:true).
      // Falls back to direct child.kill if process.kill rejects (e.g. group
      // already reaped between checks).
      try {
        if (child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try { child.kill(signal); } catch { /* gone */ }
      }
    };

    const killProc = (reason: "idle" | "wall-clock") => {
      if (killed) return;
      killed = { reason, afterMs: Date.now() - start };
      killGroup("SIGTERM");
      // Hard kill if SIGTERM doesn't take. close handler still fires.
      const sigkill = setTimeout(() => killGroup("SIGKILL"), SIGKILL_GRACE_MS);
      sigkill.unref?.();
    };

    let idleTimer: NodeJS.Timeout | null = null;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (idleMs <= 0) return;
      idleTimer = setTimeout(() => killProc("idle"), idleMs);
      idleTimer.unref?.();
    };

    const wallTimer = setTimeout(() => killProc("wall-clock"), timeoutMs);
    wallTimer.unref?.();
    armIdle();

    const onChunk = (which: "stdout" | "stderr") => (data: Buffer) => {
      if (truncated) return;
      const s = data.toString();
      bytesBuffered += s.length;
      if (bytesBuffered > MAX_BUFFER) {
        truncated = true;
        const cap = "\n[DMITRY_EXEC_BUFFER_CAP exceeded — output truncated]\n";
        if (which === "stdout") stdout += cap; else stderr += cap;
        return;
      }
      if (which === "stdout") stdout += s; else stderr += s;
      armIdle(); // any output postpones the idle deadline
    };

    child.stdout.on("data", onChunk("stdout"));
    child.stderr.on("data", onChunk("stderr"));
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});

    child.on("error", (err) => {
      clearTimeout(wallTimer);
      if (idleTimer) clearTimeout(idleTimer);
      reject(new Error(`Command failed to spawn: ${err.message}`));
    });

    child.on("close", (code, signal) => {
      clearTimeout(wallTimer);
      if (idleTimer) clearTimeout(idleTimer);
      // 124 = gnu timeout convention. Use it whenever WE killed the process,
      // so callers checking exitCode see a clear timeout signal.
      const exitCode = killed
        ? 124
        : (typeof code === "number" ? code : (signal ? -1 : 0));
      const output = (stdout + stderr).trim();
      resolve({ output, exitCode, killed });
    });
  });
}
