import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const IS_WIN = process.platform === "win32";

// Empty plugin dir used as a whitelist override: passing this to
// `claude --plugin-dir` stops CC from loading default plugin dirs,
// which otherwise inject ~1.6k tokens of plugin descriptions per spawn.
export const EMPTY_PLUGIN_DIR = join(homedir(), ".dmitry", "empty-plugins");
mkdirSync(EMPTY_PLUGIN_DIR, { recursive: true });

export function shellArgs(command: string): [string, string[]] {
  return IS_WIN
    ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]]
    : ["bash", ["-c", command]];
}

export function buildRtkSettings(): string {
  const hooks: Record<string, unknown> = {};
  const hookCmd = getRtkHookCommand();
  if (hookCmd) {
    hooks.PreToolUse = [{
      matcher: "Bash",
      hooks: [{ type: "command", command: hookCmd }],
    }];
  }
  return JSON.stringify({ claudeMdFiles: [], autoMemoryEnabled: false, hooks });
}

function getRtkHookCommand(): string | null {
  if (IS_WIN) {
    const ps1 = join(homedir(), ".claude", "hooks", "rtk-rewrite.ps1");
    if (!existsSync(ps1)) return null;
    return `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${ps1}"`;
  }
  const sh = join(homedir(), ".claude", "hooks", "rtk-rewrite.sh");
  return existsSync(sh) ? sh : null;
}
