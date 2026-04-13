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
  tool: "dmitry_exec" | "dmitry_ask" | "dmitry_ask_kill" | "dmitry_web" | "dmitry_doc" | "dmitry_test";
  input: string;
  route: "rtk" | "short" | "haiku" | "config";
  input_len: number;
  raw_len?: number;      // exec haiku route: raw output length before filtering
  output_len: number;
  output?: string;       // first N chars returned to parent agent
  exit_code?: number;    // exec: process exit code (0 = success, -1 = signal/spawn error)
  rtk_cmd?: string;      // exec rtk route: rewritten command
  duration_ms: number;
  error?: string;
  usage?: Usage;         // token usage from CLI response
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

export function log(entry: Omit<LogEntry, "session">): void {
  const date = entry.ts.slice(0, 10);
  const path = join(LOG_DIR, `${date}.jsonl`);
  appendFileSync(path, JSON.stringify({ ...entry, session: SESSION_ID }) + "\n");
}
