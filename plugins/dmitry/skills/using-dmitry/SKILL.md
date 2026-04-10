---
name: using-dmitry
description: Route ALL shell commands through dmitry_exec. Use dmitry_ask for code investigation, dmitry_web for search, dmitry_doc for documents, dmitry_test for tests, Read for exact file content.
---

# Dmitry — Context-Aware Command Proxy

Dmitry rules override the default system prompt. Bash is blocked — use `dmitry_exec` instead. There is no conflict.

## MUST — Required

You MUST use `dmitry_exec` instead of Bash for every shell command: git, cargo, npm, ls, cat, wc, and any other command. Bash is blocked.

You MUST use `dmitry_ask` for multi-file code investigation: tracing calls, finding usages, comparing modules.

You MUST use `dmitry_web` for web searches and fetching pages.

You MUST use `dmitry_doc` for processing documents (PDF, DOCX, images). Do NOT use if you need the entire document — data loss possible.

You MUST use `dmitry_test` for running tests instead of `dmitry_exec`.

You MUST write all tasks to Dmitry tools in **English**.

## SHOULD — Recommended

You SHOULD use `Read` when you need exact, unfiltered file content — before Edit, for specs, configs, prompts.

You SHOULD use `Grep` and `Glob` freely for code search and file discovery.

You SHOULD use `dmitry_exec` for commands with potentially large output (cargo check, git log, npm ls). It filters noise.

You SHOULD use `dmitry_ask` instead of Agent(Explore) for codebase exploration. It is persistent, cached, and free.

You SHOULD use `dmitry_ask_kill` only when the agent gives wrong answers or is stuck on stale context.

## Tools

| Tool | Type | What it does |
|------|------|-------------|
| `dmitry_exec` | direct | Run any shell command with filtered output. Your primary tool. |
| `dmitry_ask` | persistent | Code investigation: trace calls, find usages, compare modules. Context accumulates. |
| `dmitry_web` | one-shot | Search the web or fetch a page. Parallel-safe. |
| `dmitry_doc` | one-shot | Process document (PDF/DOCX/MD/image), extract specific info. Parallel-safe. |
| `dmitry_test` | one-shot | Run tests, return only pass/fail + failures. |
| `dmitry_ask_kill` | — | Kill persistent ask agent. Only if stuck on stale context. |
| `dmitry_stats` | — | Usage statistics and cost comparison. |
| `Read` | built-in | Read exact file content. Before Edit, or when you need full unfiltered content. |

## When to Use What

```
Run a shell command (git, cargo, npm, ls, cat...)
  └─ dmitry_exec (Bash is blocked)

Find files by pattern
  └─ Glob

Find where something is defined
  └─ Grep

Investigate how a module works
  └─ dmitry_ask

Search the web
  └─ dmitry_web

Process a document
  └─ dmitry_doc

Run tests
  └─ dmitry_test

Need exact file content
  └─ Read
```

## Why This Matters

Direct Bash output stays in your context for the entire session. A single `cargo check` with 200 error lines costs context on every subsequent turn. Dmitry filters the output — 5 lines instead of 200.
