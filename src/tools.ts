import { execCommand } from "./executor.js";
import { CliManager } from "./cli-manager.js";
import { execFile } from "node:child_process";
import { oneshot } from "./oneshot.js";
import { log } from "./logger.js";
import { IS_WIN } from "./platform.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const GLOBAL_CLAUDE_MD = join(homedir(), ".claude", "CLAUDE.md");
const DMITRY_DIR = join(homedir(), ".dmitry");
const RTK_MD_DECISION = join(DMITRY_DIR, "rtk-md-decision.json");
const RTK_IMPORT_RE = /^@RTK\.md\s*\r?\n?/m;

let rtkBannerChecked = false;

function maybeRtkBanner(): string {
  if (rtkBannerChecked) return "";
  rtkBannerChecked = true;
  if (existsSync(RTK_MD_DECISION)) return "";
  try {
    const content = readFileSync(GLOBAL_CLAUDE_MD, "utf8");
    if (!RTK_IMPORT_RE.test(content)) return "";
  } catch {
    return "";
  }
  return [
    "[dmitry] @RTK.md is imported in ~/.claude/CLAUDE.md — redundant when Dmitry is active (~500 tokens/session).",
    'Decide once: dmitry_exec "dmitry-config rtk-md=remove" | rtk-md=keep   (remove strips the line; RTK may re-add on upgrade)',
    "───",
    "",
  ].join("\n");
}

function handleConfigCommand(command: string): string | null {
  const m = command.trim().match(/^dmitry-config rtk-md=(remove|keep)$/);
  if (!m) return null;
  const choice = m[1];
  mkdirSync(DMITRY_DIR, { recursive: true });
  writeFileSync(RTK_MD_DECISION, JSON.stringify({ rtk_md: choice, ts: new Date().toISOString() }) + "\n");
  if (choice === "remove") {
    try {
      const content = readFileSync(GLOBAL_CLAUDE_MD, "utf8");
      if (!RTK_IMPORT_RE.test(content)) return "Decision saved: rtk-md=remove. No @RTK.md line found to strip.";
      writeFileSync(GLOBAL_CLAUDE_MD, content.replace(RTK_IMPORT_RE, ""));
      return "Removed @RTK.md from ~/.claude/CLAUDE.md. Decision saved.";
    } catch (e) {
      return `Decision saved but edit failed: ${(e as Error).message}`;
    }
  }
  return "Decision saved: rtk-md=keep. This banner will not appear again.";
}

// Strip markdown formatting from Haiku output.
// Haiku's base system prompt encourages markdown; we remove it deterministically
// so parent agents always receive plain text regardless of Haiku's choices.
function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")           // ## headers
    .replace(/\*\*(.+?)\*\*/g, "$1")        // **bold**
    .replace(/\*(.+?)\*/g, "$1")            // *italic*
    .replace(/`{3}[a-z]*\n?([\s\S]*?)`{3}/g, "$1") // ```code blocks```
    .replace(/`(.+?)`/g, "$1")              // `inline code`
    .replace(/^\s*[-*+]\s+/gm, "")          // bullet lists
    .replace(/^\s*\d+\.\s+/gm, "")          // numbered lists
    .replace(/^\|.+\|$/gm, (row) =>         // | table | rows | → strip pipes
      row.replace(/\|/g, " ").replace(/\s{2,}/g, "  ").trim()
    )
    .replace(/^[-|: ]+$/gm, "")             // table separator rows
    .replace(/\n{3,}/g, "\n\n")             // collapse excessive blank lines
    .trim();
}

// System prompt for exec/test output filtering.
// Haiku here is a pure text-filtering tool — it must NOT read files or
// explore the project. The task contains all data needed.
const FILTER_SYSTEM_PROMPT = [
  "You are a text-filtering tool. Your input is a command's stdout, your output is a compact version of it.",
  "Your output is consumed by Claude Opus (another LLM), not a human.",
  "",
  "Do NOT read files. Do NOT run commands. Do NOT explore the project. Do NOT read CLAUDE.md.",
  "Process ONLY the text given to you in the task. Everything you need is already in the prompt.",
  "",
  "OVERRIDE default formatting: plain text only.",
  "No backticks, no ``` blocks, no **, no ##, no | tables, no bullet lists.",
  "No preamble, no explanation, no commentary. Start directly with the data. English only.",
  "",
  "CRITICAL: Never write memory files. Never use the Write tool on any path under ~/.claude/.",
].join("\n");

function rtkRewrite(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("rtk", ["rewrite", command], { timeout: 5000, ...(IS_WIN && { shell: true }) }, (err, stdout) => {
      if (err || !stdout.trim() || stdout.trim() === command) {
        resolve(null);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

export async function handleExec(
  params: { command: string; timeout?: number },
): Promise<string> {
  const { command, timeout } = params;
  const start = Date.now();

  const configReply = handleConfigCommand(command);
  if (configReply !== null) {
    log({ ts: new Date().toISOString(), tool: "dmitry_exec", input: command, route: "config", input_len: command.length, output_len: configReply.length, duration_ms: Date.now() - start });
    return configReply;
  }

  // Check RTK first — if covered, run through RTK directly (no double execution)
  const rtkCmd = await rtkRewrite(command);
  if (rtkCmd) {
    const { output: result, exitCode } = await execCommand(rtkCmd, timeout ?? 60_000);
    log({ ts: new Date().toISOString(), tool: "dmitry_exec", input: command, route: "rtk", input_len: command.length, output_len: result.length, exit_code: exitCode, rtk_cmd: rtkCmd, output: result.slice(0, 1000), duration_ms: Date.now() - start });
    return maybeRtkBanner() + result;
  }

  // RTK doesn't cover — run raw
  const { output: raw, exitCode } = await execCommand(command, timeout ?? 60_000);
  const lineCount = raw.split("\n").length;

  // Short output — return as-is
  if (lineCount < 10) {
    log({ ts: new Date().toISOString(), tool: "dmitry_exec", input: command, route: "short", input_len: command.length, output_len: raw.length, exit_code: exitCode, output: raw.slice(0, 1000), duration_ms: Date.now() - start });
    return maybeRtkBanner() + raw;
  }

  // Long output, no RTK — send to oneshot Haiku for filtering
  const maxLines = Math.min(lineCount, 30);
  const prompt = [
    `Filter output of: ${command}`,
    `Input: ${lineCount} lines. Return max ${maxLines} lines.`,
    `Keep: errors, warnings, key values, counts, structure indicators. Drop: blank lines, repetition, decoration, progress bars.`,
    "",
    raw,
  ].join("\n");

  const { result: raw_result, usage } = await oneshot(prompt, { timeout: timeout ?? 60_000, systemPrompt: FILTER_SYSTEM_PROMPT, tools: "", replaceSystemPrompt: true });
  const result = stripMarkdown(raw_result);
  log({ ts: new Date().toISOString(), tool: "dmitry_exec", input: command, route: "haiku", input_len: command.length, raw_len: raw.length, output_len: result.length, exit_code: exitCode, output: result.slice(0, 3000), duration_ms: Date.now() - start, usage: usage ?? undefined });
  return maybeRtkBanner() + result;
}

export async function handleAsk(
  cli: CliManager,
  params: { task: string },
): Promise<string> {
  const start = Date.now();
  const { result: raw_result, usage } = await cli.send(params.task);
  const result = stripMarkdown(raw_result);
  log({ ts: new Date().toISOString(), tool: "dmitry_ask", input: params.task, route: "haiku", input_len: params.task.length, output_len: result.length, output: result.slice(0, 3000), duration_ms: Date.now() - start, usage: usage ?? undefined });
  return maybeRtkBanner() + result;
}

const WEB_SYSTEM_PROMPT = [
  "You are a web research scout. Your output is consumed by Claude Opus (another LLM), not a human.",
  "Opus calls you when he needs to discover what's out there on a topic — multiple pages, links, follow-ups.",
  "",
  "Your role: librarian, not analyst. You find, fetch, and describe pages.",
  "You do NOT judge which page has the \"right\" answer — Opus does that.",
  "You return an inventory; Opus picks what to read in full.",
  "",
  "ASYMMETRIC RULE: when in doubt, INCLUDE a page. Never DROP one for \"seems off-topic\".",
  "Adding noise is cheap — Opus skips it. Silently dropping a relevant page is unrecoverable.",
  "",
  "Workflow:",
  "1. Run WebSearch on the task. Add follow-up searches for broader coverage (typically 1-3 searches).",
  "2. Pick 5-10 pages from search results. Fetch them with WebFetch.",
  "3. If a fetched page contains links whose anchor text or URL keywords match the task,",
  "   follow them and add to the inventory. You may guess wrong — that is fine, see asymmetric rule.",
  "4. Stop after ~5-10 distinct pages. Do not over-explore.",
  "5. Drop ONLY obvious mechanical noise: 404s, cookie/login walls, exact duplicates,",
  "   shopping/ad pages with no content. Never drop a page because it \"seems off-topic\".",
  "",
  "OUTPUT (plain text):",
  "",
  "SEARCHES:",
  "- query 1",
  "- query 2",
  "",
  "PAGES:",
  "",
  "[1] https://example.com/x-guide",
  "    KIND: official docs | blog post | paper | repo README | forum thread | news | Q&A",
  "    SIZE: ~N words",
  "    HEADINGS: Installation | Usage | Patterns | Troubleshooting",
  "    EXCERPT: 200-400 chars of literal text from the page (no rephrasing)",
  "",
  "[2] https://...",
  "    ...",
  "",
  "DROPPED (mechanical noise only):",
  "- url — reason (404 / login wall / dupe of [1] / cookie page / shop page)",
  "",
  "Rules:",
  "- Never write \"this is the best\" or \"more relevant\" — Opus decides.",
  "- Never merge pages into one summary — keep them separate, one entry each.",
  "- EXCERPT must be a literal quote from the page, not a paraphrase.",
  "- Plain text only. No backticks, no ##, no **, no | tables. English only.",
].join("\n");

export async function handleWeb(params: { task: string }): Promise<string> {
  const start = Date.now();
  const prompt = [
    "RESEARCH TASK — explore the web and return an inventory of pages.",
    "",
    params.task,
  ].join("\n");

  const { result: raw_result, usage } = await oneshot(prompt, { systemPrompt: WEB_SYSTEM_PROMPT, tools: "WebSearch,WebFetch" });
  log({ ts: new Date().toISOString(), tool: "dmitry_web", input: params.task, route: "haiku", input_len: params.task.length, output_len: raw_result.length, output: raw_result.slice(0, 3000), duration_ms: Date.now() - start, usage: usage ?? undefined });
  return maybeRtkBanner() + raw_result;
}

export async function handleDoc(params: { task: string }): Promise<string> {
  const start = Date.now();
  const prompt = [
    "TASK: Process the document and extract requested information.",
    "You have Read tool for local files, WebFetch for URLs.",
    "Return: extracted content, structure summary, or specific sections as requested.",
    "Do NOT return the entire document — only what was asked for.",
    "",
    params.task,
  ].join("\n");
  const { result: raw_result, usage } = await oneshot(prompt, { timeout: 180_000, tools: "Read,Grep,Glob,WebFetch" });
  const result = stripMarkdown(raw_result);
  log({ ts: new Date().toISOString(), tool: "dmitry_doc", input: params.task, route: "haiku", input_len: params.task.length, output_len: result.length, output: result.slice(0, 3000), duration_ms: Date.now() - start, usage: usage ?? undefined });
  return maybeRtkBanner() + result;
}

export async function handleTest(params: { command: string; timeout?: number }): Promise<string> {
  const start = Date.now();
  const { output: raw, exitCode } = await execCommand(params.command, params.timeout ?? 120_000);
  const lineCount = raw.split("\n").length;

  // Short output — return as-is
  if (lineCount < 20) {
    log({ ts: new Date().toISOString(), tool: "dmitry_test", input: params.command, route: "short", input_len: params.command.length, output_len: raw.length, exit_code: exitCode, duration_ms: Date.now() - start });
    return maybeRtkBanner() + raw;
  }

  // Long output — filter through Haiku, keep only failures
  const prompt = [
    `Filter test output of: ${params.command}`,
    `Exit code: ${exitCode}. Total lines: ${lineCount}.`,
    `Return ONLY: pass/fail summary, failed test names, error messages, assertion details.`,
    `Drop: passing tests, progress indicators, timing info, stack frames beyond the first 3.`,
    "",
    raw,
  ].join("\n");
  const { result: raw_result, usage } = await oneshot(prompt, { timeout: params.timeout ?? 120_000, systemPrompt: FILTER_SYSTEM_PROMPT, tools: "", replaceSystemPrompt: true });
  const result = stripMarkdown(raw_result);
  log({ ts: new Date().toISOString(), tool: "dmitry_test", input: params.command, route: "haiku", input_len: params.command.length, raw_len: raw.length, output_len: result.length, exit_code: exitCode, output: result.slice(0, 3000), duration_ms: Date.now() - start, usage: usage ?? undefined });
  return maybeRtkBanner() + result;
}

export function handleAskKill(cli: CliManager): string {
  const wasAlive = cli.isAlive();
  cli.kill();
  const status = wasAlive ? "Ask agent killed and context cleared." : "Ask agent was not running.";
  log({ ts: new Date().toISOString(), tool: "dmitry_ask_kill", input: "kill", route: "short", input_len: 0, output_len: status.length, duration_ms: 0 });
  return status;
}
