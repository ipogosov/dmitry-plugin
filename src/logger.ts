// JSONL logger for dmitry MCP — ~/.dmitry/logs/{date}.jsonl
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const LOG_DIR = join(homedir(), ".dmitry", "logs");
const SESSION_ID = randomBytes(4).toString("hex");

mkdirSync(LOG_DIR, { recursive: true });

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  num_turns: number;
}

interface LogEntry {
  ts: string;
  session: string;
  tool: "dmitry_exec" | "dmitry_ask" | "dmitry_ask_kill" | "dmitry_web" | "dmitry_doc" | "dmitry_test" | "dmitry_task";
  input: string;
  route: "rtk" | "rtk-haiku" | "rtk-oversize" | "short" | "haiku" | "oversize";
  input_len: number;
  raw_len?: number;      // exec haiku route: raw output length before filtering
  output_len?: number;
  output?: string;       // first N chars returned to parent agent
  exit_code?: number;    // exec: process exit code (0 = success, 124 = killed by dmitry, -1 = signal/spawn error)
  rtk_cmd?: string;      // exec rtk route: rewritten command
  killed?: { reason: "idle" | "wall-clock"; afterMs: number };  // exec/test: process killed by idle watchdog or wall-clock cap
  duration_ms: number;
  error?: string;
  usage?: Usage;         // token usage from CLI response
  model?: "haiku" | "sonnet" | "opus";  // dmitry_task: which model handled the call
  model_switched?: boolean;             // dmitry_task: whether this call killed+respawned the instance
  context_1m?: boolean;                 // dmitry_task: 1M-context dispatch (claude --model <m>[1m])
}

export function extractUsage(msg: Record<string, unknown>): Usage | null {
  const u = msg.usage as Record<string, unknown> | undefined;
  if (!u) return null;
  return {
    input_tokens: (u.input_tokens as number) || 0,
    output_tokens: (u.output_tokens as number) || 0,
    cache_read_tokens: (u.cache_read_input_tokens as number) || 0,
    cache_creation_tokens: (u.cache_creation_input_tokens as number) || 0,
    cost_usd: (msg.total_cost_usd as number) || 0,
    num_turns: (msg.num_turns as number) || 0,
  };
}

export function mergeUsage(acc: Usage | null, assistantMsg: Record<string, unknown>): Usage | null {
  const inner = assistantMsg.message as Record<string, unknown> | undefined;
  const u = inner?.usage as Record<string, unknown> | undefined;
  if (!u) return acc;
  const delta = {
    input_tokens: (u.input_tokens as number) || 0,
    output_tokens: (u.output_tokens as number) || 0,
    cache_read_tokens: (u.cache_read_input_tokens as number) || 0,
    cache_creation_tokens: (u.cache_creation_input_tokens as number) || 0,
  };
  if (!acc) return { ...delta, cost_usd: 0, num_turns: 0 };
  return {
    input_tokens: acc.input_tokens + delta.input_tokens,
    output_tokens: acc.output_tokens + delta.output_tokens,
    cache_read_tokens: acc.cache_read_tokens + delta.cache_read_tokens,
    cache_creation_tokens: acc.cache_creation_tokens + delta.cache_creation_tokens,
    cost_usd: 0,
    num_turns: 0,
  };
}

export function log(entry: Omit<LogEntry, "session">): void {
  const date = entry.ts.slice(0, 10);
  const path = join(LOG_DIR, `${date}.jsonl`);
  appendFileSync(path, JSON.stringify({ ...entry, session: SESSION_ID }) + "\n");
}

// Heartbeat lives in its own daily file so stats.ts aggregation isn't polluted.
// Operator reads via `tail -f ~/.dmitry/logs/heartbeat-$(date +%F).jsonl` during
// long dispatches. WHY separate from stderr: Claude Code on current versions
// discards MCP server stderr; a file is the only user-visible channel.
export interface HeartbeatLogEntry {
  ts: string;
  session: string;
  turn: number;
  model: "haiku" | "sonnet" | "opus" | "?";
  summary: string;
}

export function logHeartbeat(entry: Omit<HeartbeatLogEntry, "session">): void {
  const date = entry.ts.slice(0, 10);
  const path = join(LOG_DIR, `heartbeat-${date}.jsonl`);
  appendFileSync(path, JSON.stringify({ ...entry, session: SESSION_ID }) + "\n");
}

// Per-turn profile for investigating dispatch-vs-inline slowness (H1: mandatory
// re-Read, H2: unfiltered Bash context bloat, H3: verify-every-change tax).
// One JSONL entry per dispatch with full per-turn breakdown; aggregate offline
// with jq. Separate file so the shape can evolve without breaking stats.ts.
export interface TurnProfile {
  turn: number;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  tools: string[];
}

export interface TaskProfileEntry {
  ts: string;
  session: string;
  dispatch_id: string;
  model: "haiku" | "sonnet" | "opus";
  context_1m: boolean;
  task_preview: string;
  outcome: "success" | "error" | "cancelled";
  total_duration_ms: number;
  total_turns: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  turns: TurnProfile[];
}

export function logTaskProfile(entry: Omit<TaskProfileEntry, "session">): void {
  const date = entry.ts.slice(0, 10);
  const path = join(LOG_DIR, `task-profile-${date}.jsonl`);
  appendFileSync(path, JSON.stringify({ ...entry, session: SESSION_ID }) + "\n");
}
