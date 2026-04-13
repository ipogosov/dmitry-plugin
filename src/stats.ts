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

// Opus context storage cost per token: 1× cache_write + N× cache_read,
// where N = number of turns the content stays alive in the parent session.
// Real sessions span many turns; we report two scenarios side-by-side.
const OPUS_RATES = [
  { turns: 3,  rate: (PRICING.opus.cache_write + 3  * PRICING.opus.cache_read) / 1_000_000 },
  { turns: 15, rate: (PRICING.opus.cache_write + 15 * PRICING.opus.cache_read) / 1_000_000 },
] as const;

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

interface FilterCall { raw: number; out: number; haikuCost: number; }
interface InvestCall { usage: Usage; haikuCost: number; }

interface FilterSummary { count: number; raw: number; out: number; haiku: number; saved: number[]; }
interface InvestSummary { count: number; opus: number; haiku: number; saved: number; }

function filterSummary(items: FilterCall[]): FilterSummary {
  let raw = 0, out = 0, haiku = 0;
  for (const it of items) { raw += it.raw; out += it.out; haiku += it.haikuCost; }
  const deltaTokens = (raw - out) / CHARS_PER_TOKEN;
  const saved = OPUS_RATES.map(r => deltaTokens * r.rate - haiku);
  return { count: items.length, raw, out, haiku, saved };
}

function investSummary(items: InvestCall[]): InvestSummary {
  const u: Usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 0, num_turns: 0 };
  let haiku = 0;
  for (const it of items) {
    u.input_tokens          += it.usage.input_tokens;
    u.output_tokens         += it.usage.output_tokens;
    u.cache_read_tokens     += it.usage.cache_read_tokens;
    u.cache_creation_tokens += it.usage.cache_creation_tokens;
    haiku += it.haikuCost;
  }
  const opus = calcCost("opus", u);
  return { count: items.length, opus, haiku, saved: opus - haiku };
}

// Split items into bottom 95% and top 5% ranked by a per-item signal.
// Used to separate typical calls from spike/outlier calls.
function splitP95<T>(items: T[], rankBy: (t: T) => number): { bottom: T[]; top: T[] } {
  if (items.length < 2) return { bottom: items, top: [] };
  const sorted = [...items].sort((a, b) => rankBy(a) - rankBy(b));
  const keepN = Math.max(1, Math.floor(items.length * 0.95));
  return { bottom: sorted.slice(0, keepN), top: sorted.slice(keepN) };
}

// Outlier ranking signals — rate-independent so the split is stable.
const filterCallDelta = (c: FilterCall) => c.raw - c.out;
const investCallSaving = (c: InvestCall) => calcCost("opus", c.usage) - c.haikuCost;

function fmt$(n: number): string {
  const sign = n < 0 ? "-$" : "$";
  return (sign + Math.abs(n).toFixed(2)).padStart(8);
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
  const execFilter: FilterCall[] = [];

  // Investigation (ask/web/doc/test): parent would have done the same work itself.
  // Savings = Haiku workload × Opus rate − Haiku actual cost.
  const invest: InvestCall[] = [];

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
      execFilter.push({ raw: e.raw_len, out: e.output_len, haikuCost: e.usage.cost_usd });
    } else if (e.tool !== "dmitry_exec") {
      invest.push({ usage: e.usage, haikuCost: e.usage.cost_usd });
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
  const rateHeader = OPUS_RATES.map(r => `${r.turns}-turn`.padStart(8)).join("  ");
  lines.push(`  (Opus keeps context across N turns)     ${rateHeader}`);
  lines.push("");

  // Totals accumulate across both buckets, for each Opus rate scenario.
  const totalAll  = OPUS_RATES.map(() => 0);
  const totalBot  = OPUS_RATES.map(() => 0);
  const totalTop  = OPUS_RATES.map(() => 0);

  if (execFilter.length > 0) {
    const { bottom, top } = splitP95(execFilter, filterCallDelta);
    const all = filterSummary(execFilter);
    const bot = filterSummary(bottom);
    const tip = filterSummary(top);

    all.saved.forEach((s, i) => { totalAll[i] += s; });
    bot.saved.forEach((s, i) => { totalBot[i] += s; });
    tip.saved.forEach((s, i) => { totalTop[i] += s; });

    lines.push(`  exec filtering (${all.count} calls)`);
    lines.push(`    total   ${formatSize(all.raw)} -> ${formatSize(all.out)}`.padEnd(42) + all.saved.map(fmt$).join("  "));
    if (top.length > 0) {
      lines.push(`    p95×${bot.count}  ${formatSize(bot.raw)} -> ${formatSize(bot.out)}`.padEnd(42) + bot.saved.map(fmt$).join("  "));
      lines.push(`    top5%×${tip.count} ${formatSize(tip.raw)} dumped in spikes`.padEnd(42) + tip.saved.map(fmt$).join("  "));
    }
  }

  if (invest.length > 0) {
    const { bottom, top } = splitP95(invest, investCallSaving);
    const all = investSummary(invest);
    const bot = investSummary(bottom);
    const tip = investSummary(top);

    // Investigation bucket is rate-independent (same number in both columns).
    OPUS_RATES.forEach((_, i) => {
      totalAll[i] += all.saved;
      totalBot[i] += bot.saved;
      totalTop[i] += tip.saved;
    });

    lines.push("");
    lines.push(`  investigation (${all.count} calls, rate-independent)`);
    lines.push(`    total   Opus $${all.opus.toFixed(2)} - Haiku $${all.haiku.toFixed(2)}`.padEnd(42) + fmt$(all.saved));
    if (top.length > 0) {
      lines.push(`    p95×${bot.count}  Opus $${bot.opus.toFixed(2)} - Haiku $${bot.haiku.toFixed(2)}`.padEnd(42) + fmt$(bot.saved));
      lines.push(`    top5%×${tip.count} Opus $${tip.opus.toFixed(2)} - Haiku $${tip.haiku.toFixed(2)}`.padEnd(42) + fmt$(tip.saved));
    }
  }

  lines.push("");
  lines.push(`  ${"-".repeat(58)}`);
  lines.push(`  Total`.padEnd(42)                          + totalAll.map(fmt$).join("  "));
  lines.push(`  Total p95 (typical, spikes removed)`.padEnd(42) + totalBot.map(fmt$).join("  "));
  lines.push(`  Total top5% (spikes alone)`.padEnd(42)     + totalTop.map(fmt$).join("  "));

  lines.push("");
  lines.push("Not counted in $ above:");
  lines.push(`  ${bypassCalls} RTK/short bypass calls (0 LLM cost; raw size not logged)`);
  const unmeteredHaiku = Math.max(0, (byRoute.haiku || 0) - meteredCalls);
  if (unmeteredHaiku > 0) {
    lines.push(`  ${unmeteredHaiku} haiku calls pre-metering (older logs without usage)`);
  }
  lines.push("");
  lines.push(`Assumptions: 1 token ≈ ${CHARS_PER_TOKEN} chars; parent context cost = 1× cache_write + N× cache_read.`);
  lines.push(`p95 = bottom 95% of calls (typical load), top5% = outlier spikes, ranked by per-call impact.`);

  return lines.join("\n");
}
