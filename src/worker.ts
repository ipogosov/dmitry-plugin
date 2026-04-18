// Worker process. Owns all claude-CLI lifecycle. Never writes to stdout or stdin —
// those belong to the MCP server's JSON-RPC pipe in the parent. Talks to the parent
// exclusively over Node IPC (process.send / process.on("message")).
//
// WHY a separate process: if a spawned claude CLI misbehaves (stream error, EPIPE,
// uncaughtException) and crashes the worker, the parent observes a clean 'exit'
// event on its IPC channel and restarts us. The MCP pipe to Claude Code stays
// alive. Crash isolation is structural, not a discipline check.

import { CliManager } from "./cli-manager.js";
import { TaskManager } from "./task-manager.js";
import { handleExec, handleAsk, handleAskKill, handleWeb, handleDoc, handleTest, handleTask } from "./tools.js";
import { log } from "./logger.js";
import { IS_WIN } from "./platform.js";

const cli = new CliManager();
const task = new TaskManager();

function logWorkerError(kind: string, err: unknown): void {
  const msg = err instanceof Error ? (err.stack || err.message) : String(err);
  // Piggy-back on the existing log schema. Tool "dmitry_exec" is arbitrary — the
  // error text carries the real origin. Keeps stats.ts unchanged.
  log({
    ts: new Date().toISOString(),
    tool: "dmitry_exec",
    input: `<worker ${kind}>`,
    route: "short",
    input_len: 0,
    output_len: 0,
    duration_ms: 0,
    error: `${kind}: ${msg}`,
  });
}

// Safety net: log and keep running. The dispatcher still sees a clean reply
// for in-flight calls if any handler promise rejected; this only catches the
// detached ones (timer callbacks, stream events).
process.on("unhandledRejection", (reason) => { logWorkerError("unhandledRejection", reason); });
process.on("uncaughtException",  (err)    => { logWorkerError("uncaughtException",  err);    });

type CallMessage = { id: string; kind: "call"; tool: string; params: Record<string, unknown> };
type CancelMessage = { id: string; kind: "cancel"; tool: string; timeout_ms: number };
type IncomingMessage = CallMessage | CancelMessage;

async function dispatch(tool: string, params: Record<string, unknown>): Promise<string> {
  switch (tool) {
    case "dmitry_exec": return handleExec(params as { command: string; timeout?: number });
    case "dmitry_ask":  return handleAsk(cli, params as { task: string });
    case "dmitry_ask_kill": return handleAskKill(cli);
    case "dmitry_web":  return handleWeb(params as { task: string });
    case "dmitry_doc":  return handleDoc(params as { task: string });
    case "dmitry_test": return handleTest(params as { command: string; timeout?: number });
    case "dmitry_task": return handleTask(task, params as { task?: string; model?: "haiku" | "sonnet" | "opus"; kill?: boolean; context_1m?: boolean });
    default: throw new Error(`unknown tool: ${tool}`);
  }
}

type DmitryTool = "dmitry_exec" | "dmitry_ask" | "dmitry_ask_kill" | "dmitry_web" | "dmitry_doc" | "dmitry_test" | "dmitry_task";

function logHandlerError(tool: string, params: Record<string, unknown>, err: unknown, durationMs: number): void {
  const input = typeof params?.task === "string" ? params.task
              : typeof params?.command === "string" ? params.command
              : "";
  const text = err instanceof Error ? err.message : String(err);
  // Best-effort: handlers own their success logs; we log only when they throw,
  // so an error still shows up in stats and the daily JSONL.
  const knownTools: DmitryTool[] = ["dmitry_exec", "dmitry_ask", "dmitry_ask_kill", "dmitry_web", "dmitry_doc", "dmitry_test", "dmitry_task"];
  const loggedTool: DmitryTool = (knownTools as string[]).includes(tool) ? (tool as DmitryTool) : "dmitry_exec";
  log({
    ts: new Date().toISOString(),
    tool: loggedTool,
    input,
    route: "haiku",
    input_len: input.length,
    output_len: text.length,
    duration_ms: durationMs,
    error: text,
  });
}

process.on("message", (raw: unknown) => {
  const msg = raw as IncomingMessage | null;
  if (!msg) return;
  if (msg.kind === "cancel") {
    // Dispatcher-initiated cancel (e.g. on timeout). Scope: dmitry_task only.
    // task.cancel() resolves the in-flight activeRequest with a partial-result
    // marker; the pending dispatch() promise then resolves normally and the
    // final {ok:true, result: "[DMITRY_TIMEOUT...]"} goes back over IPC.
    if (msg.tool === "dmitry_task") task.cancel(msg.timeout_ms);
    return;
  }
  if (msg.kind !== "call") return;
  const { id, tool, params } = msg;
  const start = Date.now();
  dispatch(tool, params ?? {}).then(
    (result) => { process.send?.({ id, kind: "result", ok: true,  result }); },
    (err)    => {
      logHandlerError(tool, params ?? {}, err, Date.now() - start);
      const text = err instanceof Error ? err.message : String(err);
      process.send?.({ id, kind: "result", ok: false, error: text });
    },
  );
});

process.on("SIGTERM", () => { cli.kill(); task.kill("process SIGTERM"); process.exit(0); });
process.on("SIGINT",  () => { cli.kill(); task.kill("process SIGINT");  process.exit(0); });
if (IS_WIN) process.on("SIGBREAK", () => { cli.kill(); task.kill("process SIGBREAK"); process.exit(0); });

// Tell the dispatcher we're ready to accept calls.
process.send?.({ kind: "ready" });
