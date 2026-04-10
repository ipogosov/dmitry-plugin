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
npm run dev:on       # Switch to dev mode (symlink to local source)
npm run dev:off      # Switch back to prod (last published version)
npm run dev:status   # Show current mode
```

## Workflow

### Development
```
npm run dev:on       # once — switch plugin to local source
src/*.ts → edit → npm run bundle → restart Claude session → test
```

### Release
```
npm run dev:off      # switch back to prod
bump version in plugins/dmitry/.claude-plugin/plugin.json
git add + commit + push
```

Dev mode creates a symlink `~/.claude/plugins/cache/dmitry-plugin/dmitry/dev` → `plugins/dmitry/`. Each `npm run bundle` updates the bundle in-place. Restart session to pick up changes.

## Gotchas

- **Bundle is the deployed artifact.** Never edit `dmitry.mjs` directly — changes are overwritten by `npm run bundle`.
- **Permission deadlock.** Haiku subprocesses in `--print` mode can't pass interactive permission prompts. Tools like WebSearch/WebFetch must be pre-approved via `--allowedTools` in spawn args.
- **DMITRY_INTERNAL env.** Set on persistent agent spawn — hooks check it to bypass blocking for Dmitry's own CLI processes.
- **stripMarkdown().** Haiku's base prompt encourages markdown; we strip it post-hoc so parent agents get plain text.
- **Logs.** `~/.dmitry/logs/{date}.jsonl` — each entry has session ID, tool, route, input/output lengths, duration.
