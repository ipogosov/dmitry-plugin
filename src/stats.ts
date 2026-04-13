import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Usage } from "./logger.js";

// Per million tokens (April 2026)
const PRICING = {
  haiku:  { input: 1.00, output:  5.00, cache_read: 0.10, cache_write:  2.00 },
  sonnet: { input: 3.00, output: 15.00, cache_read: 0.30, cache_write:  6.00 },
  opus:   { input: 5.00, output: 25.00, cache_read: 0.50, cache_write: 10.00 },
} as const;

const CHARS_PER_TOKEN = 4;

// What it costs to keep one token of raw content alive in the Opus parent session:
// written to cache once, then read at least once. Minimum realistic — real sessions
// re-read content on every turn that follows, so this is a lower bound.
const OPUS_CONTEXT_RATE_PER_TOKEN =
  (PRICING.opus.cache_write + PRICING.opus.cache_read) / 1_000_000;

function calcCost(model: keyof typeof PRICING, u: Usage): number {
  const p = PRICING[model];
  return (
    u.input_tokens          * p.input       / 1_000_000 +
    u.output_tokens         * p.output      / 1_000_000 +
    u.cache_read_tokens     * p.cache_read  / 1_000_000 +
    u.cache_creation_tokens * p.cache_write / 1_000_000
  );
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + " MB";
  if (bytes >= 1024)        return (bytes / 1024).toFixed(1) + " KB";
  return bytes + " B";
}

interface LogEntry {
  tool: string;
  route: string;
  duration_ms: number;
  raw_len?: number;
  output_len: number;
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

  const byTool: Record<string, number> = {};
  const byRoute: Record<string, number> = {};
  let totalDuration = 0;
  let meteredCalls = 0;
  let bypassCalls = 0;

  const allUsage: Usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 0, num_turns: 0 };

  // exec filtering: parent would have seen raw_len in its own context.
  // Savings = (raw - output) tokens × Opus cache cost − Haiku actual cost.
  let execFilterCalls = 0;
  let execFilterRawLen = 0;
  let execFilterOutLen = 0;
  let execFilterHaikuCost = 0;

  // Investigation (ask/web/doc/test): parent would have done the same work itself.
  // Savings = Haiku workload × Opus rate − Haiku actual cost.
  let investCalls = 0;
  let investHaikuCost = 0;
  const investUsage: Usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 0, num_turns: 0 };

  for (const e of entries) {
    byTool[e.tool] = (byTool[e.tool] || 0) + 1;
    byRoute[e.route] = (byRoute[e.route] || 0) + 1;
    totalDuration += e.duration_ms || 0;

    if (e.route === "rtk" || e.route === "short") bypassCalls++;

    if (!e.usage) continue;
    meteredCalls++;
    allUsage.input_tokens          += e.usage.input_tokens;
    allUsage.output_tokens         += e.usage.output_tokens;
    allUsage.cache_read_tokens     += e.usage.cache_read_tokens;
    allUsage.cache_creation_tokens += e.usage.cache_creation_tokens;
    allUsage.cost_usd              += e.usage.cost_usd;
    allUsage.num_turns             += e.usage.num_turns;

    if (e.route !== "haiku") continue;

    if (e.tool === "dmitry_exec" && e.raw_len != null) {
      execFilterCalls      += 1;
      execFilterRawLen     += e.raw_len;
      execFilterOutLen     += e.output_len;
      execFilterHaikuCost  += e.usage.cost_usd;
    } else if (e.tool !== "dmitry_exec") {
      investCalls                       += 1;
      investHaikuCost                   += e.usage.cost_usd;
      investUsage.input_tokens          += e.usage.input_tokens;
      investUsage.output_tokens         += e.usage.output_tokens;
      investUsage.cache_read_tokens     += e.usage.cache_read_tokens;
      investUsage.cache_creation_tokens += e.usage.cache_creation_tokens;
    }
  }

  const lines: string[] = [];
  lines.push(`Dmitry Stats (${period})`);
  lines.push("=".repeat(40));
  lines.push(`Calls: ${entries.length} total`);
  const toolParts = Object.entries(byTool).map(([t, n]) => `${n} ${t.replace("dmitry_", "")}`);
  lines.push(`  ${toolParts.join(", ")}`);
  const routeParts = Object.entries(byRoute).map(([r, n]) => `${n} ${r}`);
  lines.push(`Routes: ${routeParts.join(", ")}`);
  lines.push(`Duration: ${(totalDuration / 1000).toFixed(1)}s total`);

  if (meteredCalls === 0) {
    lines.push("");
    lines.push("No token usage data yet.");
    return lines.join("\n");
  }

  lines.push("");
  lines.push(`Haiku actual spend (${meteredCalls} metered calls): $${allUsage.cost_usd.toFixed(2)}`);
  lines.push(`  in=${allUsage.input_tokens.toLocaleString()} out=${allUsage.output_tokens.toLocaleString()} cache_r=${allUsage.cache_read_tokens.toLocaleString()} cache_w=${allUsage.cache_creation_tokens.toLocaleString()}`);

  lines.push("");
  lines.push("Savings vs Opus:");
  let totalSaved = 0;

  if (execFilterCalls > 0) {
    const deltaChars  = execFilterRawLen - execFilterOutLen;
    const deltaTokens = deltaChars / CHARS_PER_TOKEN;
    const opusAvoided = deltaTokens * OPUS_CONTEXT_RATE_PER_TOKEN;
    const saved       = opusAvoided - execFilterHaikuCost;
    totalSaved += saved;
    lines.push(`  exec filtering (${execFilterCalls} calls):  $${saved.toFixed(2)}`);
    lines.push(`    ${formatSize(execFilterRawLen)} raw -> ${formatSize(execFilterOutLen)} filtered (parent context cost avoided)`);
  }

  if (investCalls > 0) {
    const opusCost = calcCost("opus", investUsage);
    const saved    = opusCost - investHaikuCost;
    totalSaved += saved;
    lines.push(`  investigation  (${investCalls} calls):   $${saved.toFixed(2)}`);
    lines.push(`    Opus $${opusCost.toFixed(2)} - Haiku $${investHaikuCost.toFixed(2)} (same workload repriced)`);
  }

  lines.push(`  ${"-".repeat(42)}`);
  lines.push(`  Total measured savings:    $${totalSaved.toFixed(2)}`);

  lines.push("");
  lines.push("Not counted in $ above:");
  lines.push(`  ${bypassCalls} RTK/short bypass calls (0 LLM cost; raw size not logged)`);
  const unmeteredHaiku = Math.max(0, (byRoute.haiku || 0) - meteredCalls);
  if (unmeteredHaiku > 0) {
    lines.push(`  ${unmeteredHaiku} haiku calls pre-metering (older logs without usage)`);
  }
  lines.push("");
  lines.push(`Assumptions: 1 token ≈ ${CHARS_PER_TOKEN} chars; parent context cost = 1× cache_write + 1× cache_read.`);

  return lines.join("\n");
}
