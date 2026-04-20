// Failure reporter — builds a prefilled GitHub issue URL on Dmitry-level failures.
//
// Scope (option "a"): thrown exceptions in handlers, spawn/timeout/binary-not-found,
// CLI disconnects, stderr matching shell-mismatch signatures. NOT plain exitCode!=0
// from user commands (grep no-match, failing tests, etc. — those are command semantics,
// not Dmitry bugs).
//
// Emits once per qualifying failure. The URL is appended to the tool's response as a
// trailer so the parent agent can present it to the operator. No network call from
// here — the operator clicks the link, GitHub prefills the issue form in their browser.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, platform, release, arch } from "node:os";
import { join } from "node:path";
import { IS_WIN } from "./platform.js";

const REPO = "ivanpogosov/dmitry-plugin";
const LOG_DIR = join(homedir(), ".dmitry", "logs");
const PLUGIN_JSON = join(homedir(), ".claude", "plugins", "installed_plugins.json");
// URL character budget — GitHub accepts much more, but browsers (Safari in particular)
// start truncating past ~8k. Keep the encoded body comfortably under that.
const MAX_URL_BYTES = 7000;
const MAX_FIELD_CHARS = 500;
const MAX_STDERR_CHARS = 1500;

export type FailureKind =
  | "throw"
  | "timeout"
  | "binary_not_found"
  | "cli_disconnect"
  | "shell_mismatch";

export interface FailureContext {
  tool: string;
  kind: FailureKind;
  error_message: string;
  input_preview?: string;
  stderr_preview?: string;
  exit_code?: number;
}

// Infer the failure kind from a thrown Error. Used by the server-side wrap() which
// only sees the rejection — not the original ENOENT/timeout semantics.
export function classifyThrown(err: unknown): FailureKind {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (lower.includes("timed out")) return "timeout";
  if (lower.includes("enoent") || lower.includes("not found") || lower.includes("spawn")) {
    return "binary_not_found";
  }
  if (lower.includes("cli exited") || lower.includes("worker exited") || lower.includes("disconnected")) {
    return "cli_disconnect";
  }
  return "throw";
}

// Detect shell-mismatch: bash-syntax command ran through PowerShell or cmd and the
// interpreter complained. These are the top suspects for the Windows report flow.
const SHELL_MISMATCH_PATTERNS = [
  /is not recognized as the name of a cmdlet/i,
  /is not recognized as an internal or external command/i,
  /CommandNotFoundException/i,
  /The term '.+' is not recognized/i,
  /: command not found/,
];

export function detectShellMismatch(text: string): boolean {
  if (!text) return false;
  return SHELL_MISMATCH_PATTERNS.some((re) => re.test(text));
}

// Replace anything that could leak identity from a string: absolute home paths,
// then the username inside any residual POSIX-looking path. Token/key heuristics
// are out of scope — we do not log secrets to begin with.
function redact(text: string): string {
  if (!text) return text;
  const home = homedir();
  // Windows paths may arrive with either \ or / separators; normalize both.
  const homeVariants = [home, home.replace(/\\/g, "/")];
  let out = text;
  for (const v of homeVariants) {
    if (v) out = out.split(v).join("<HOME>");
  }
  // Residual "/Users/<name>/" or "/home/<name>/" not caught by the homedir match.
  out = out.replace(/\/(?:Users|home)\/[^/\s"']+/g, "/<HOME>");
  // Windows: C:\Users\<name>\
  out = out.replace(/[A-Za-z]:\\Users\\[^\\/\s"']+/g, "C:\\Users\\<HOME>");
  return out;
}

function truncate(text: string, max: number): string {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max) + `… [+${text.length - max} chars]`;
}

// Probe the environment without throwing. Each probe is best-effort — a failure
// to detect something is itself a useful signal in the report.
interface EnvProbes {
  git_bash: string;
  rtk: string;
  grep: string;
  node: string;
  claude: string;
  path_sep: string;
}

function which(binary: string): string {
  try {
    const cmd = IS_WIN ? "where" : "which";
    const out = execFileSync(cmd, [binary], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out.split(/\r?\n/)[0] || "not found";
  } catch {
    return "not found";
  }
}

function probeVersion(binary: string, args: string[] = ["--version"]): string {
  try {
    const out = execFileSync(binary, args, {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
      ...(IS_WIN && { shell: true }),
    }).trim();
    return out.split(/\r?\n/)[0] || "unknown";
  } catch {
    return "not found";
  }
}

function probeGitBash(): string {
  if (!IS_WIN) return "n/a (POSIX)";
  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  const w = which("bash");
  return w === "not found" ? "not found" : w;
}

function probeEnv(): EnvProbes {
  return {
    git_bash: probeGitBash(),
    rtk: which("rtk"),
    grep: which("grep"),
    node: probeVersion("node"),
    claude: probeVersion("claude", ["--version"]),
    path_sep: IS_WIN ? ";" : ":",
  };
}

function readPluginVersion(): string {
  // Prefer the plugin.json bundled alongside the running server. Fallback: parse the
  // installed_plugins.json registry to find dmitry's installPath and read its manifest.
  const candidates: string[] = [];
  const here = process.argv[1];
  if (here) {
    candidates.push(join(here, "..", "..", ".claude-plugin", "plugin.json"));
    candidates.push(join(here, "..", "..", "..", ".claude-plugin", "plugin.json"));
  }
  try {
    if (existsSync(PLUGIN_JSON)) {
      const registry = JSON.parse(readFileSync(PLUGIN_JSON, "utf8")) as Record<string, unknown>;
      const plugins = registry.plugins as Record<string, Array<Record<string, unknown>>> | undefined;
      const entries = plugins?.["dmitry@dmitry-plugin"];
      const installPath = entries?.[0]?.installPath as string | undefined;
      if (installPath) candidates.push(join(installPath, ".claude-plugin", "plugin.json"));
    }
  } catch {
    // ignore
  }
  for (const p of candidates) {
    try {
      const m = JSON.parse(readFileSync(p, "utf8")) as { version?: string };
      if (m.version) return m.version;
    } catch {
      // try next
    }
  }
  return "unknown";
}

interface RecentFailure {
  ts: string;
  tool: string;
  route: string;
  exit_code?: number;
  error?: string;
  input_preview: string;
}

// Walk today's and yesterday's log files, pick entries that look like failures.
// Intent here matches the reporter scope — we surface errors and shell-mismatch
// suspects, not plain non-zero exits.
function recentFailures(limit = 5): RecentFailure[] {
  if (!existsSync(LOG_DIR)) return [];
  let files: string[];
  try {
    files = readdirSync(LOG_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort()
      .reverse()
      .slice(0, 2);
  } catch {
    return [];
  }
  const out: RecentFailure[] = [];
  for (const f of files) {
    let content: string;
    try {
      content = readFileSync(join(LOG_DIR, f), "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n").filter(Boolean);
    // Walk newest-first within the file.
    for (let i = lines.length - 1; i >= 0; i--) {
      if (out.length >= limit) break;
      try {
        const e = JSON.parse(lines[i]!) as Record<string, unknown>;
        const err = e.error as string | undefined;
        const out_text = (e.output as string | undefined) ?? "";
        const hasErr = typeof err === "string" && err.length > 0;
        const hasMismatch = detectShellMismatch(out_text);
        if (!hasErr && !hasMismatch) continue;
        out.push({
          ts: String(e.ts ?? ""),
          tool: String(e.tool ?? ""),
          route: String(e.route ?? ""),
          exit_code: typeof e.exit_code === "number" ? e.exit_code : undefined,
          error: err,
          input_preview: truncate(String(e.input ?? ""), 160),
        });
      } catch {
        // ignore malformed line
      }
    }
    if (out.length >= limit) break;
  }
  return out;
}

function formatBody(ctx: FailureContext): string {
  const env = probeEnv();
  const plug = readPluginVersion();
  const recent = recentFailures(5);
  const lines: string[] = [];
  lines.push("## Failure");
  lines.push(`Tool: ${ctx.tool}`);
  lines.push(`Kind: ${ctx.kind}`);
  if (ctx.exit_code !== undefined) lines.push(`Exit code: ${ctx.exit_code}`);
  lines.push(`Error: ${truncate(redact(ctx.error_message), MAX_FIELD_CHARS)}`);
  if (ctx.input_preview) {
    lines.push("");
    lines.push("## Input (truncated)");
    lines.push("```");
    lines.push(truncate(redact(ctx.input_preview), MAX_FIELD_CHARS));
    lines.push("```");
  }
  if (ctx.stderr_preview) {
    lines.push("");
    lines.push("## Stderr (truncated)");
    lines.push("```");
    lines.push(truncate(redact(ctx.stderr_preview), MAX_STDERR_CHARS));
    lines.push("```");
  }
  lines.push("");
  lines.push("## Environment");
  lines.push(`Platform: ${platform()} ${release()} (${arch()})`);
  lines.push(`Node: ${env.node}`);
  lines.push(`Claude CLI: ${env.claude}`);
  lines.push(`Dmitry plugin: ${plug}`);
  lines.push(`PATH separator: ${env.path_sep}`);
  lines.push("");
  lines.push("## Probes");
  lines.push(`- Git Bash: ${redact(env.git_bash)}`);
  lines.push(`- rtk: ${redact(env.rtk)}`);
  lines.push(`- grep: ${redact(env.grep)}`);
  if (recent.length > 0) {
    lines.push("");
    lines.push("## Recent failures (from ~/.dmitry/logs)");
    for (const r of recent) {
      const parts = [r.ts, r.tool];
      if (r.exit_code !== undefined) parts.push(`exit=${r.exit_code}`);
      parts.push(`route=${r.route}`);
      lines.push(`- ${parts.join(" ")}`);
      if (r.error) lines.push(`  error: ${truncate(redact(r.error), 240)}`);
      if (r.input_preview) lines.push(`  input: ${redact(r.input_preview)}`);
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("Auto-generated by Dmitry failure reporter. Verify no sensitive data before submitting.");
  return lines.join("\n");
}

function formatTitle(ctx: FailureContext): string {
  const plat = IS_WIN ? "win" : platform();
  const head = truncate(ctx.error_message.split("\n")[0] || "failure", 80);
  return `[${plat}] ${ctx.tool} ${ctx.kind}: ${head}`;
}

export function buildIssueUrl(ctx: FailureContext): string {
  const title = formatTitle(ctx);
  let body = formatBody(ctx);
  const base = `https://github.com/${REPO}/issues/new`;
  const labels = ["auto-report", IS_WIN ? "windows" : platform()].join(",");
  const build = (b: string) =>
    `${base}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(b)}&labels=${encodeURIComponent(labels)}`;
  let url = build(body);
  if (url.length > MAX_URL_BYTES) {
    const trim = "\n\n[body truncated — see ~/.dmitry/logs/ for full context]";
    // Iteratively shrink the body until the URL fits. Encoding inflates length
    // nondeterministically (multi-byte chars), so a simple loop beats math here.
    while (url.length > MAX_URL_BYTES && body.length > 500) {
      body = body.slice(0, Math.floor(body.length * 0.8)) + trim;
      url = build(body);
    }
  }
  return url;
}

// Build the human-facing trailer appended to a tool's response. Kept short so it
// does not bloat the parent agent's context when failures are rare.
export function reportTrailer(ctx: FailureContext): string {
  const url = buildIssueUrl(ctx);
  return [
    "",
    "---",
    "⚠ Dmitry hit an internal failure. If this is reproducible, file a report:",
    url,
  ].join("\n");
}
