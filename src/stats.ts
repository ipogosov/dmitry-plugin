import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Usage } from "./logger.js";

// Per million tokens (April 2026)
const PRICING: Record<string, { input: number; output: number; cache_read: number; cache_write: number }> = {
  haiku:  { input: 1.00, output:  5.00, cache_read: 0.10, cache_write:  2.00 },
  sonnet: { input: 3.00, output: 15.00, cache_read: 0.30, cache_write:  6.00 },
  opus:   { input: 5.00, output: 25.00, cache_read: 0.50, cache_write: 10.00 },
};

function calcCost(model: keyof typeof PRICING, u: Usage): number {
  const p = PRICING[model];
  return (
    u.input_tokens          * p.input      / 1_000_000 +
    u.output_tokens         * p.output     / 1_000_000 +
    u.cache_read_tokens     * p.cache_read / 1_000_000 +
    u.cache_creation_tokens * p.cache_write / 1_000_000
  );
}

interface LogEntry {
  tool: string;
  route: string;
  duration_ms: number;
  usage?: Usage;
}

export function computeStats(period: "today" | "week" | "all"): string {
  const logDir = join(homedir(), ".dmitry", "logs");
  let files: string[];
  try {
    files = readdirSync(logDir).filter(f => f.endsWith(".jsonl")).sort();
  } catch {
    return "No logs found. Dmitry hasn't been used yet.";
  }

  if (files.length === 0) return "No logs found.";

  const now = new Date();
  const cutoff = period === "today"
    ? now.toISOString().slice(0, 10)
    : period === "week"
      ? new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10)
      : "0000";

  const entries: LogEntry[] = [];
  for (const file of files) {
    const date = file.replace(".jsonl", "");
    if (date < cutoff) continue;
    const lines = readFileSync(join(logDir, file), "utf8").trim().split("\n");
    for (const line of lines) {
      try { entries.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }

  if (entries.length === 0) return `No calls in period: ${period}.`;

  // Aggregate
  const byTool: Record<string, number> = {};
  const byRoute: Record<string, number> = {};
  let totalDuration = 0;
  const totalUsage: Usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 0, num_turns: 0 };
  let callsWithUsage = 0;

  for (const e of entries) {
    byTool[e.tool] = (byTool[e.tool] || 0) + 1;
    byRoute[e.route] = (byRoute[e.route] || 0) + 1;
    totalDuration += e.duration_ms || 0;
    if (e.usage) {
      callsWithUsage++;
      totalUsage.input_tokens += e.usage.input_tokens;
      totalUsage.output_tokens += e.usage.output_tokens;
      totalUsage.cache_read_tokens += e.usage.cache_read_tokens;
      totalUsage.cache_creation_tokens += e.usage.cache_creation_tokens;
      totalUsage.cost_usd += e.usage.cost_usd;
      totalUsage.num_turns += e.usage.num_turns;
    }
  }

  const haikuCost = callsWithUsage > 0 ? totalUsage.cost_usd : null;
  const sonnetCost = callsWithUsage > 0 ? calcCost("sonnet", totalUsage) : null;
  const opusCost = callsWithUsage > 0 ? calcCost("opus", totalUsage) : null;

  const lines: string[] = [];
  lines.push(`Dmitry Stats (${period})`);
  lines.push(`${"=".repeat(40)}`);
  lines.push(`Calls: ${entries.length} total`);

  const toolParts = Object.entries(byTool).map(([t, n]) => `${n} ${t.replace("dmitry_", "")}`);
  lines.push(`  ${toolParts.join(", ")}`);

  const routeParts = Object.entries(byRoute).map(([r, n]) => `${n} ${r}`);
  lines.push(`Routes: ${routeParts.join(", ")}`);
  lines.push(`Duration: ${(totalDuration / 1000).toFixed(1)}s total`);

  if (callsWithUsage > 0) {
    lines.push("");
    lines.push(`Token Usage (${callsWithUsage} calls with data):`);
    lines.push(`  Input:          ${totalUsage.input_tokens.toLocaleString()}`);
    lines.push(`  Output:         ${totalUsage.output_tokens.toLocaleString()}`);
    lines.push(`  Cache read:     ${totalUsage.cache_read_tokens.toLocaleString()}`);
    lines.push(`  Cache creation: ${totalUsage.cache_creation_tokens.toLocaleString()}`);
    lines.push(`  Turns:          ${totalUsage.num_turns}`);
    lines.push("");
    lines.push(`Cost:`);
    lines.push(`  Haiku (actual):  $${haikuCost!.toFixed(4)}`);
    lines.push(`  On Sonnet:       $${sonnetCost!.toFixed(4)} (${(sonnetCost! / haikuCost!).toFixed(1)}x)`);
    lines.push(`  On Opus:         $${opusCost!.toFixed(4)} (${(opusCost! / haikuCost!).toFixed(1)}x)`);
    lines.push(`  Saved vs Opus:   $${(opusCost! - haikuCost!).toFixed(4)}`);
  } else {
    lines.push("");
    lines.push("No token usage data yet (older logs without usage tracking).");
  }

  return lines.join("\n");
}
