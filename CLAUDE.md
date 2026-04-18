# Dmitry Plugin

Claude Code plugin — MCP proxy that filters shell output before it reaches the parent agent's context.

## Architecture

Two spawn modes for Haiku subprocess:
- **Oneshot** (`src/oneshot.ts`): `claude --print`, stateless, parallel-safe. Used by exec (long output), web, doc, test.
- **Persistent** (`src/cli-manager.ts`): `claude --input-format stream-json`, session memory accumulates. Used by ask.

Routing in `src/tools.ts`:
- `exec`: command → RTK rewrite? → yes: instant (0 LLM cost) / no: run raw → <10 lines: as-is / ≥10 lines: oneshot Haiku filter
- `ask`: persistent Haiku agent, context accumulates across calls
- `web/doc/test`: oneshot Haiku with specific prompt

## Key Files

| File | Role |
|------|------|
| `src/index.ts` | MCP server, tool registration (7 tools) |
| `src/tools.ts` | Tool handlers, stripMarkdown(), RTK routing |
| `src/cli-manager.ts` | Persistent Haiku agent (ask), spawn config, queue |
| `src/oneshot.ts` | One-shot Haiku (exec filter, web, doc, test), spawn config |
| `src/executor.ts` | execFile("bash", ["-c", cmd]) wrapper |
| `src/platform.ts` | IS_WIN detection, RTK settings builder |
| `src/logger.ts` | JSONL logs to ~/.dmitry/logs/{date}.jsonl |
| `src/stats.ts` | Usage aggregation, cost comparison |
| `plugins/dmitry/hooks/` | PreToolUse enforcement (block Bash/Grep/Glob/Web) |
| `plugins/dmitry/skills/` | SKILL.md — tells Claude when to use which tool |

## Commands

```bash
npm run build        # TypeScript check (tsc → dist/)
npm run bundle       # esbuild → plugins/dmitry/server/dmitry.mjs
```

## Workflow

Single-source install: `installPath` in `~/.claude/plugins/installed_plugins.json` points directly at `plugins/dmitry/` in this repo. No cache copies, no dev/prod toggle — one authoritative location.

### Editing
```
src/*.ts → edit → npm run bundle → restart Claude session → test
```

### Release
```
bump version in plugins/dmitry/.claude-plugin/plugin.json
git add + commit + push
```

## Gotchas

- **Bundle is the deployed artifact.** Never edit `dmitry.mjs` directly — changes are overwritten by `npm run bundle`.
- **Permission deadlock.** Haiku subprocesses in `--print` mode can't pass interactive permission prompts. Tools like WebSearch/WebFetch must be pre-approved via `--allowedTools` in spawn args.
- **DMITRY_INTERNAL env.** Set on persistent agent spawn — hooks check it to bypass blocking for Dmitry's own CLI processes.
- **stripMarkdown().** Haiku's base prompt encourages markdown; we strip it post-hoc so parent agents get plain text.
- **Logs.** `~/.dmitry/logs/{date}.jsonl` — each entry has session ID, tool, route, input/output lengths, duration.
