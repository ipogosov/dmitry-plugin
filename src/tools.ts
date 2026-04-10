import { execCommand } from "./executor.js";
import { CliManager } from "./cli-manager.js";
import { execFile } from "node:child_process";
import { oneshot } from "./oneshot.js";
import { log } from "./logger.js";
import { IS_WIN } from "./platform.js";

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

  // Check RTK first — if covered, run through RTK directly (no double execution)
  const rtkCmd = await rtkRewrite(command);
  if (rtkCmd) {
    const { output: result, exitCode } = await execCommand(rtkCmd, timeout ?? 60_000);
    log({ ts: new Date().toISOString(), tool: "dmitry_exec", input: command, route: "rtk", input_len: command.length, output_len: result.length, exit_code: exitCode, rtk_cmd: rtkCmd, output: result.slice(0, 1000), duration_ms: Date.now() - start });
    return result;
  }

  // RTK doesn't cover — run raw
  const { output: raw, exitCode } = await execCommand(command, timeout ?? 60_000);
  const lineCount = raw.split("\n").length;

  // Short output — return as-is
  if (lineCount < 10) {
    log({ ts: new Date().toISOString(), tool: "dmitry_exec", input: command, route: "short", input_len: command.length, output_len: raw.length, exit_code: exitCode, output: raw.slice(0, 1000), duration_ms: Date.now() - start });
    return raw;
  }

  // Long output, no RTK — send to oneshot Haiku for filtering
  const maxLines = Math.min(lineCount, 30);
  const prompt = [
    `Filter output of: ${command}`,
    `Input: ${lineCount} lines. Return max ${maxLines} lines. PLAIN TEXT ONLY — no markdown, no backticks, no headers.`,
    `Keep: errors, warnings, key values, counts, structure indicators. Drop: blank lines, repetition, decoration, progress bars.`,
    `Start directly with the data. No preamble, no explanation.`,
    `DO NOT read any project files or CLAUDE.md — only process the text given below.`,
    "",
    raw,
  ].join("\n");

  const { result: raw_result, usage } = await oneshot(prompt, timeout ?? 60_000);
  const result = stripMarkdown(raw_result);
  log({ ts: new Date().toISOString(), tool: "dmitry_exec", input: command, route: "haiku", input_len: command.length, raw_len: raw.length, output_len: result.length, exit_code: exitCode, output: result.slice(0, 3000), duration_ms: Date.now() - start, usage: usage ?? undefined });
  return result;
}

export async function handleAsk(
  cli: CliManager,
  params: { task: string },
): Promise<string> {
  const start = Date.now();
  const { result: raw_result, usage } = await cli.send(params.task);
  const result = stripMarkdown(raw_result);
  log({ ts: new Date().toISOString(), tool: "dmitry_ask", input: params.task, route: "haiku", input_len: params.task.length, output_len: result.length, output: result.slice(0, 3000), duration_ms: Date.now() - start, usage: usage ?? undefined });
  return result;
}

export async function handleWeb(params: { task: string }): Promise<string> {
  const start = Date.now();
  const isUrl = /^https?:\/\//i.test(params.task.trim());

  const prompt = isUrl
    ? [
        "TASK: Fetch this URL with WebFetch and return clean, readable content.",
        "You are a reader-mode parser. Extract useful content from the HTML page.",
        "",
        "KEEP: main article/documentation text, headings (as plain text lines), links (as [text](url)),",
        "code blocks, tables, lists, API signatures, version numbers.",
        "",
        "REMOVE: navigation menus, sidebars, footers, cookie banners, ads, scripts, CSS,",
        "social media buttons, 'related articles', breadcrumbs, login prompts.",
        "",
        "FORMAT: plain text with natural structure. Use blank lines between sections.",
        "Preserve link URLs inline as [text](url) — the caller needs them.",
        "Do NOT summarize or rephrase — return the actual page content, cleaned up.",
        "If the page is very long, return the first ~3000 words of main content.",
        "",
        params.task,
      ].join("\n")
    : [
        "TASK: Search the web for the query below using WebSearch.",
        "Then fetch the most relevant 1-2 pages with WebFetch.",
        "Return the CLEAN CONTENT of those pages — not a summary, not bullet points.",
        "",
        "For each page, return:",
        "SOURCE: [url]",
        "Then the cleaned page content (reader mode — no HTML noise, keep text/links/tables).",
        "",
        "Do NOT summarize or rephrase. Return actual content from the pages.",
        "If a page is long, return the most relevant ~2000 words.",
        "",
        params.task,
      ].join("\n");

  const { result: raw_result, usage } = await oneshot(prompt);
  log({ ts: new Date().toISOString(), tool: "dmitry_web", input: params.task, route: "haiku", input_len: params.task.length, output_len: raw_result.length, output: raw_result.slice(0, 3000), duration_ms: Date.now() - start, usage: usage ?? undefined });
  return raw_result;
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
  const { result: raw_result, usage } = await oneshot(prompt, 180_000);
  const result = stripMarkdown(raw_result);
  log({ ts: new Date().toISOString(), tool: "dmitry_doc", input: params.task, route: "haiku", input_len: params.task.length, output_len: result.length, output: result.slice(0, 3000), duration_ms: Date.now() - start, usage: usage ?? undefined });
  return result;
}

export async function handleTest(params: { command: string; timeout?: number }): Promise<string> {
  const start = Date.now();
  const { output: raw, exitCode } = await execCommand(params.command, params.timeout ?? 120_000);
  const lineCount = raw.split("\n").length;

  // Short output — return as-is
  if (lineCount < 20) {
    log({ ts: new Date().toISOString(), tool: "dmitry_test", input: params.command, route: "short", input_len: params.command.length, output_len: raw.length, exit_code: exitCode, duration_ms: Date.now() - start });
    return raw;
  }

  // Long output — filter through Haiku, keep only failures
  const prompt = [
    `Filter test output of: ${params.command}`,
    `Exit code: ${exitCode}. Total lines: ${lineCount}.`,
    `Return ONLY: pass/fail summary, failed test names, error messages, assertion details.`,
    `Drop: passing tests, progress indicators, timing info, stack frames beyond the first 3.`,
    `PLAIN TEXT ONLY. Start directly with results.`,
    "",
    raw,
  ].join("\n");
  const { result: raw_result, usage } = await oneshot(prompt, params.timeout ?? 120_000);
  const result = stripMarkdown(raw_result);
  log({ ts: new Date().toISOString(), tool: "dmitry_test", input: params.command, route: "haiku", input_len: params.command.length, raw_len: raw.length, output_len: result.length, exit_code: exitCode, output: result.slice(0, 3000), duration_ms: Date.now() - start, usage: usage ?? undefined });
  return result;
}

export function handleAskKill(cli: CliManager): string {
  const wasAlive = cli.isAlive();
  cli.kill();
  const status = wasAlive ? "Ask agent killed and context cleared." : "Ask agent was not running.";
  log({ ts: new Date().toISOString(), tool: "dmitry_ask_kill", input: "kill", route: "short", input_len: 0, output_len: status.length, duration_ms: 0 });
  return status;
}
