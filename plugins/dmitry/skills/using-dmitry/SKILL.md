---
name: using-dmitry
description: Route ALL shell commands through dmitry_exec. Use dmitry_task to delegate mechanical code work to Sonnet (replaces native Task), dmitry_ask for code investigation, dmitry_web for multi-step web research, dmitry_doc for documents, dmitry_test for tests, Read for exact file content.
---

# Dmitry — Context-Aware Command Proxy

Bash, Grep, Glob, and Task are blocked at the PreToolUse hook. Route through Dmitry MCP tools instead. Read and Edit are not blocked.

## Tools

| Tool | Type | What it does |
|------|------|-------------|
| `dmitry_exec` | one-shot | Any shell command (git, npm, ls, cat, find, grep, wc). RTK-covered commands run instantly with zero LLM cost; long output is filtered through Haiku. |
| `dmitry_task` | persistent | Delegate a task to a Sonnet subagent (default) — or Haiku/Opus if specified. Full code tools (Read/Edit/Write/Grep/Glob/Bash), verifies its own work (typecheck/build/test), returns a compact diff + verification result. Replaces native Task. Context accumulates across calls; idle > 5 min → auto-killed. Pass `kill: true` to reset early. |
| `dmitry_ask` | persistent | Cross-file code investigation: trace calls, find usages, locate symbols. Returns locations (file:line), not summaries. **Context accumulates across calls** — group related questions; use `dmitry_ask_kill` to reset. |
| `dmitry_test` | one-shot | Run tests (npm test, cargo test, pytest). Returns only pass/fail + failure details. Do not add `--verbose` to "see more" — there is no more. |
| `dmitry_doc` | one-shot | Extract specific info from PDF/DOCX/image. Do NOT use if you need the full document in context — use Read instead. |
| `dmitry_web` | one-shot | Multi-step web research. Returns an INVENTORY of pages (URL + kind + headings + literal excerpt) — you pick what to fetch. Does NOT judge which page has the right answer. |

## Routing

```
Run a shell command                   → dmitry_exec
Find a symbol / string                → dmitry_exec("grep -rn 'pat' path")   # RTK = instant
Find files by name                    → dmitry_exec("find . -name '*.ts'")   # RTK = instant
Understand code across files          → dmitry_ask
Multi-file implementation,            → dmitry_task(task, model="sonnet")
   feature/sprint/phase work,         #   persistent Sonnet subagent
   tests + verification loop,
   refactor/rename across many files
Novel design, debug unknown behavior  → dmitry_task(task, model="opus")   # rare
Read N files + list structure         → Read inline (not dmitry_task)
Copy/move/archive files               → dmitry_exec (not dmitry_task)
1-line fix in known file              → Read → Edit (not dmitry_task)
Edit a known file yourself            → Read → Edit
Run tests                             → dmitry_test
Extract from a document               → dmitry_doc
Single known URL                      → WebFetch (yourself)
Single keyword search                 → WebSearch (yourself)
Multi-step web research               → dmitry_web
```

## Rules

- Native `Task` is blocked. Use `dmitry_task` — same shape, cheaper default (Sonnet), logged in telemetry.
- `dmitry_task` default model is **Sonnet**. Only pass `model="opus"` when Opus-grade reasoning is truly required (design decisions, debugging unknown behavior, novel logic). Most delegated work is Sonnet-grade.
- `dmitry_task` is a single persistent instance — calls are queued and run serially. Switching models mid-session kills the instance and respawns fresh (context lost). Pick one tier per task thread.
- **Do NOT delegate to `dmitry_task` if any of these hold:**
  - Reading a handful of files and reporting structure / exports / TODOs — do it inline with Read.
  - Pure file system action (copy, move, archive, mkdir) — `dmitry_exec`.
  - Single-line or single-hunk edit in a known file — Read + Edit inline.
  - "Validation probe" / "tell me whether X is true" with a hand-crafted step list — execute inline.
  - Expected work is < ~10 turns and < $0.50 — delegation overhead (MCP dispatch + result cache_write) eats the savings.
  Delegate when the task is genuinely multi-turn: write + run tests + read failures + iterate, or refactor that touches many files with cascading verifications.
- Never use `dmitry_ask` for design or trade-off decisions — those are yours, not Haiku's.
- Use `dmitry_ask` instead of `Agent(Explore)` for codebase investigation — it's persistent, cached, and cheaper.
- Use `dmitry_web` only when you need 2+ searches or don't know which page has the answer. For a single known URL or one obvious search, use WebFetch/WebSearch yourself.
- Write all task descriptions to Dmitry tools in **English**.
- **If `dmitry_task` returns `"No such tool available"`:** the MCP server disconnected. Ask the operator to run `/mcp` and reconnect `dmitry`. If reconnect fails, STOP the current task and ask the operator how to proceed — do NOT fall back to native `Task`/`Agent`.
