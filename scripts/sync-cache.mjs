#!/usr/bin/env node
// Mirror the freshly-built bundle into the CC plugin cache path if the
// local installed_plugins.json points there instead of this repo.
// Keeps dev edits visible to a running CC session without touching the
// marketplace update flow (cache paths are what end users get).

import { readFileSync, copyFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoBundle = join(repoRoot, "plugins/dmitry/server/dmitry.mjs");
const repoPluginDir = join(repoRoot, "plugins/dmitry");
const registryPath = join(homedir(), ".claude/plugins/installed_plugins.json");

if (!existsSync(registryPath)) process.exit(0);
if (!existsSync(repoBundle)) {
  console.error(`[sync-cache] repo bundle missing: ${repoBundle}`);
  process.exit(1);
}

const registry = JSON.parse(readFileSync(registryPath, "utf8"));
const entries = registry?.plugins?.["dmitry@dmitry-plugin"];
if (!Array.isArray(entries) || entries.length === 0) process.exit(0);

for (const entry of entries) {
  const installPath = entry?.installPath;
  if (!installPath) continue;
  if (resolve(installPath) === resolve(repoPluginDir)) {
    console.log(`[sync-cache] installPath already repo — nothing to mirror`);
    continue;
  }
  const target = join(installPath, "server/dmitry.mjs");
  if (!existsSync(target)) {
    console.warn(`[sync-cache] target missing, skipping: ${target}`);
    continue;
  }
  copyFileSync(repoBundle, target);
  const size = statSync(target).size;
  console.log(`[sync-cache] mirrored → ${target} (${size} bytes)`);
}
