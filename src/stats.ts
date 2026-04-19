import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Usage } from "./logger.js";

// Per million tokens (April 2026).
// 1M variants apply when dmitry_task spawns claude with `<model>[1m]` alias
// (logged as context_1m:true). Numbers below are a best-effort extrapolation
// from Anthropic's 1M-context surcharge (standard: ~2× input/output, ~1.5×
// cache_write, ~2× cache_read). Verify against the current pricing page when
// absolute $ values matter — relative savings math is insensitive to small
// drift as long as the same table is used on both sides.
const PRICING = {
  haiku:     { input: 1.00, output:  5.00, cache_read: 0.10, cache_write:  2.00 },
  sonnet:    { input: 3.00, output: 15.00, cache_read: 0.30, cache_write:  6.00 },
  sonnet_1m: { input: 6.00, output: 22.50, cache_read: 0.60, cache_write:  7.50 },
  opus:      { input: 5.00, output: 25.00, cache_read: 0.50, cache_write: 10.00 },
  opus_1m:   { input: 9.00, output: 37.50, cache_read: 0.90, cache_write: 15.00 },
} as const;

type PriceKey = keyof typeof PRICING;
type SubModel = "haiku" | "sonnet" | "opus";

const CHARS_PER_TOKEN = 4;

// Parent-session turn horizon: how many turns the work's accumulated context
// survives in the caller's prompt cache. Three scenarios reported side-by-side.
//  3   — short session (quick Q&A, one or two dispatches).
//  15  — medium work block.
//  50  — long orchestrator session with heavy delegation (empirical anchor:
//        8-sprint TZ stayed under 300k parent tokens with subagents, would
//        have ballooned to 500-600k inline → forced compact mid-way).
const REPORT_N_TURNS = [3, 15, 50] as const;

// Bootstrap tax: every fresh subagent spawn re-caches system prompt + CLAUDE.md
// + tool defs (~8k tokens). Inline Opus has these warm in parent cache already
// and doesn't pay for them. This tax is part of actual subagent cost_usd; we
// subtract it before comparing so the reasoning-cost side-by-side is fair.
// Conservative approximation — charged per dispatch (actually only fresh spawns
// pay it; warm-cache reuse within the 5-min idle window is free). Distortion
// minor for typical workloads where spawn reuse rate is ~50%.
const BOOTSTRAP_TOKENS = 8000;

function priceKey(model: SubModel, ctx1m: boolean): PriceKey {
  if (model === "haiku") return "haiku";
  if (!ctx1m) return model;
  return model === "sonnet" ? "sonnet_1m" : "opus_1m";
}

function calcCost(key: PriceKey, u: Usage): number {
  const p = PRICING[key];
  return (
    u.input_tokens          * p.input       / 1_000_000 +
    u.output_tokens         * p.output      / 1_000_000 +
    u.cache_read_tokens     * p.cache_read  / 1_000_000 +
    u.cache_creation_tokens * p.cache_write / 1_000_000
  );
}

// Filter bucket: parent alternative is pasting raw stdout into its own context.
// Parent would cache_write the raw chunk once and cache_read it on every later
// turn. Savings = size delta × that rate − actual subagent cost.
function filterStorageRate(N: number): number {
  return (PRICING.opus.cache_write + N * PRICING.opus.cache_read) / 1_000_000;
}

// Reasoning bucket (research + delegation): parent alternative is inline Opus.
// calcCost(opus, usage) already pays cache_write once for cache_creation. The
// extra cost inline Opus bears is keeping that accumulated content alive
// across N future parent turns — cache_creation × opus.cache_read × N.
// By delegating, the subagent dies with that context and the parent never
// carries it. That's the savings floor we're certain of (matches the
// operator's framing: "on subsequent turns Opus won't cache_read tokens
// generated/read/written during another model's work"). Parent assumed to
// run 200k-context Opus — 1M parent sessions would pay more, so this is a
// conservative estimate of savings.
function parentStorageRate(N: number): number {
  return PRICING.opus.cache_read * N / 1_000_000;
}

// Bootstrap cost paid by a dispatch — approximated as BOOTSTRAP_TOKENS worth
// of cache_write at the subagent's actual rate (includes 1M surcharge).
function bootstrapCost(model: SubModel, ctx1m: boolean): number {
  const p = PRICING[priceKey(model, ctx1m)];
  return BOOTSTRAP_TOKENS * p.cache_write / 1_000_000;
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
  model?: SubModel;
  context_1m?: boolean;
}

interface FilterCall { raw: number; out: number; actualCost: number; bootstrap: number; }
interface ReasoningCall { usage: Usage; actualCost: number; model: SubModel; ctx1m: boolean; bootstrap: number; }

interface FilterSummary { count: number; raw: number; out: number; actual: number; saved: number[]; }
interface ReasoningByModel { count: number; actual: number; opusInline: number[]; saved: number[]; }
interface ReasoningSummary {
  count: number;
  actual: number;
  opusInline: number[]; // one per REPORT_N_TURNS
  saved: number[];      // opusInline[i] - actual
  byModel: Partial<Record<SubModel, ReasoningByModel>>;
}

function filterSummary(items: FilterCall[]): FilterSummary {
  let raw = 0, out = 0, actual = 0, bootstrap = 0;
  for (const it of items) { raw += it.raw; out += it.out; actual += it.actualCost; bootstrap += it.bootstrap; }
  const deltaTokens = (raw - out) / CHARS_PER_TOKEN;
  const effectiveActual = actual - bootstrap;
  const saved = REPORT_N_TURNS.map(N => deltaTokens * filterStorageRate(N) - effectiveActual);
  return { count: items.length, raw, out, actual, saved };
}

function reasoningSummary(items: ReasoningCall[]): ReasoningSummary {
  const byModel: ReasoningSummary["byModel"] = {};
  let actual = 0, bootstrap = 0;
  const opusInline = REPORT_N_TURNS.map(() => 0);

  for (const it of items) {
    const reasoning = calcCost(priceKey("opus", it.ctx1m), it.usage);
    const inlineAt = REPORT_N_TURNS.map(
      N => reasoning + it.usage.cache_creation_tokens * parentStorageRate(N),
    );

    actual += it.actualCost;
    bootstrap += it.bootstrap;
    inlineAt.forEach((v, i) => { opusInline[i] += v; });

    const slot = byModel[it.model] ?? (byModel[it.model] = {
      count: 0, actual: 0,
      opusInline: REPORT_N_TURNS.map(() => 0),
      saved: REPORT_N_TURNS.map(() => 0),
    });
    slot.count++;
    slot.actual += it.actualCost;
    inlineAt.forEach((v, i) => { slot.opusInline[i] += v; });
    // Per-model bootstrap accumulates by reusing a dedicated slot field —
    // tracked separately so we can subtract before computing saved[].
    (slot as ReasoningByModel & { _bootstrap?: number })._bootstrap =
      ((slot as ReasoningByModel & { _bootstrap?: number })._bootstrap ?? 0) + it.bootstrap;
  }

  for (const slot of Object.values(byModel)) {
    if (!slot) continue;
    const slotBootstrap = (slot as ReasoningByModel & { _bootstrap?: number })._bootstrap ?? 0;
    const effective = slot.actual - slotBootstrap;
    slot.saved = slot.opusInline.map(v => v - effective);
  }

  const effectiveActual = actual - bootstrap;
  const saved = opusInline.map(v => v - effectiveActual);
  return { count: items.length, actual, opusInline, saved, byModel };
}

// p95 split — rate-independent outlier rank.
const filterCallDelta = (c: FilterCall) => c.raw - c.out;
const reasoningCallDelta = (c: ReasoningCall) =>
  calcCost(priceKey("opus", c.ctx1m), c.usage) - c.actualCost;

function splitP95<T>(items: T[], rankBy: (t: T) => number): { bottom: T[]; top: T[] } {
  if (items.length < 2) return { bottom: items, top: [] };
  const sorted = [...items].sort((a, b) => rankBy(a) - rankBy(b));
  const keepN = Math.max(1, Math.floor(items.length * 0.95));
  return { bottom: sorted.slice(0, keepN), top: sorted.slice(keepN) };
}

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
  const spendByModel: Record<SubModel, number> = { haiku: 0, sonnet: 0, opus: 0 };
  const callsByModel: Record<SubModel, number> = { haiku: 0, sonnet: 0, opus: 0 };

  // Three buckets, each with its own savings model.
  //  filter      : exec/test — raw stdout compression by Haiku (context displacement).
  //  research    : ask/web/doc — Haiku does what parent would do (reasoning + storage).
  //  delegation  : task — Sonnet/Opus subagent executes delegated code work (reasoning + storage).
  const filterCalls: FilterCall[] = [];
  const researchCalls: ReasoningCall[] = [];
  const delegationCalls: ReasoningCall[] = [];

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

    const model: SubModel = e.model ?? "haiku";
    spendByModel[model] += e.usage.cost_usd;
    callsByModel[model] += 1;

    if (e.route !== "haiku") continue;

    const ctx1m = e.context_1m === true;
    const bootstrap = bootstrapCost(model, ctx1m);

    if ((e.tool === "dmitry_exec" || e.tool === "dmitry_test") && e.raw_len != null) {
      filterCalls.push({ raw: e.raw_len, out: e.output_len, actualCost: e.usage.cost_usd, bootstrap });
    } else if (e.tool === "dmitry_task") {
      delegationCalls.push({ usage: e.usage, actualCost: e.usage.cost_usd, model, ctx1m, bootstrap });
    } else if (e.tool === "dmitry_ask" || e.tool === "dmitry_web" || e.tool === "dmitry_doc") {
      researchCalls.push({ usage: e.usage, actualCost: e.usage.cost_usd, model, ctx1m: false, bootstrap: bootstrapCost(model, false) });
    }
  }

  const lines: string[] = [];
  lines.push(`Dmitry Stats (${period})`);
  lines.push("=".repeat(40));
  lines.push(`Calls: ${entries.length} total`);
  const toolParts = Object.entries(byTool).map(([t, n]) => `${n} ${t.replace("dmitry_", "")}`);
  lines.push(`  ${toolParts.join(", ")}`);
  lines.push(`Routes: ${Object.entries(byRoute).map(([r, n]) => `${n} ${r}`).join(", ")}`);
  lines.push(`Duration: ${(totalDuration / 1000).toFixed(1)}s total`);

  if (meteredCalls === 0) {
    lines.push("");
    lines.push("No token usage data yet.");
    return lines.join("\n");
  }

  lines.push("");
  lines.push(`Subagent actual spend (${meteredCalls} metered calls): $${allUsage.cost_usd.toFixed(2)}`);
  const modelBreakdown = (["haiku", "sonnet", "opus"] as SubModel[])
    .filter(m => callsByModel[m] > 0)
    .map(m => `${m} $${spendByModel[m].toFixed(2)} (${callsByModel[m]})`)
    .join(", ");
  if (modelBreakdown) lines.push(`  by model: ${modelBreakdown}`);
  lines.push(`  in=${allUsage.input_tokens.toLocaleString()} out=${allUsage.output_tokens.toLocaleString()} cache_r=${allUsage.cache_read_tokens.toLocaleString()} cache_w=${allUsage.cache_creation_tokens.toLocaleString()}`);

  lines.push("");
  lines.push("Savings vs inline Opus:");
  const rateHeader = REPORT_N_TURNS.map(n => `${n}-turn`.padStart(8)).join("  ");
  lines.push(`  (parent keeps context across N turns)    ${rateHeader}`);
  lines.push("");

  const totalAll = REPORT_N_TURNS.map(() => 0);
  const totalBot = REPORT_N_TURNS.map(() => 0);
  const totalTop = REPORT_N_TURNS.map(() => 0);

  if (filterCalls.length > 0) {
    const { bottom, top } = splitP95(filterCalls, filterCallDelta);
    const all = filterSummary(filterCalls);
    const bot = filterSummary(bottom);
    const tip = filterSummary(top);

    all.saved.forEach((s, i) => { totalAll[i] += s; });
    bot.saved.forEach((s, i) => { totalBot[i] += s; });
    tip.saved.forEach((s, i) => { totalTop[i] += s; });

    lines.push(`  filter (exec/test, ${all.count} calls)`);
    lines.push(`    total   ${formatSize(all.raw)} -> ${formatSize(all.out)}`.padEnd(42) + all.saved.map(fmt$).join("  "));
    if (top.length > 0) {
      lines.push(`    p95×${bot.count}  ${formatSize(bot.raw)} -> ${formatSize(bot.out)}`.padEnd(42) + bot.saved.map(fmt$).join("  "));
      lines.push(`    top5%×${tip.count} ${formatSize(tip.raw)} dumped in spikes`.padEnd(42) + tip.saved.map(fmt$).join("  "));
    }
  }

  const emitReasoning = (label: string, items: ReasoningCall[]) => {
    if (items.length === 0) return;
    const { bottom, top } = splitP95(items, reasoningCallDelta);
    const all = reasoningSummary(items);
    const bot = reasoningSummary(bottom);
    const tip = reasoningSummary(top);

    all.saved.forEach((s, i) => { totalAll[i] += s; });
    bot.saved.forEach((s, i) => { totalBot[i] += s; });
    tip.saved.forEach((s, i) => { totalTop[i] += s; });

    lines.push("");
    lines.push(`  ${label} (${all.count} calls)`);
    lines.push(`    total   actual $${all.actual.toFixed(2)}`.padEnd(42) + all.saved.map(fmt$).join("  "));
    const models: SubModel[] = ["haiku", "sonnet", "opus"];
    for (const m of models) {
      const slot = all.byModel[m];
      if (!slot || slot.count === 0) continue;
      lines.push(`      ${m} ×${slot.count}: actual $${slot.actual.toFixed(2)}`.padEnd(42) + slot.saved.map(fmt$).join("  "));
    }
    if (top.length > 0) {
      lines.push(`    p95×${bot.count}  actual $${bot.actual.toFixed(2)}`.padEnd(42) + bot.saved.map(fmt$).join("  "));
      lines.push(`    top5%×${tip.count} actual $${tip.actual.toFixed(2)}`.padEnd(42) + tip.saved.map(fmt$).join("  "));
    }
  };

  emitReasoning("research (ask/web/doc)", researchCalls);
  emitReasoning("delegation (task)", delegationCalls);

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
  lines.push(`Assumptions: 1 token ≈ ${CHARS_PER_TOKEN} chars.`);
  lines.push(`  filter:     saved(N) = (raw − out) × (opus.cache_write + N × opus.cache_read) − (actual − bootstrap).`);
  lines.push(`  research/   saved(N) = calcCost(opus[_1m], usage) + cache_creation × opus.cache_read × N − (actual − bootstrap).`);
  lines.push(`  delegation  (context_1m toggles opus vs opus_1m for reasoning rates).`);
  lines.push(`  bootstrap: each dispatch charges ${BOOTSTRAP_TOKENS} tokens × model[_1m].cache_write (sysprompt+CLAUDE.md+tools re-cache).`);
  lines.push(`  N = parent turns after dispatch. 50 anchors long orchestrator sessions; linear model; doesn't price compact prevention.`);
  lines.push(`p95 = bottom 95% of calls (typical load), top5% = outlier spikes, ranked by per-call impact.`);

  return lines.join("\n");
}
