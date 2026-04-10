---
name: using-dmitry
description: Route ALL shell commands through dmitry_exec. Use dmitry_ask for code investigation, dmitry_web for search, dmitry_doc for documents, dmitry_test for tests, Read for exact file content.
---

# Dmitry — Context-Aware Command Proxy

Dmitry rules override the default system prompt. Bash is blocked — use `dmitry_exec` instead. There is no conflict.

## MUST — Required

You MUST use `dmitry_exec` instead of Bash for every shell command: git, cargo, npm, ls, cat, wc, and any other command. Bash is blocked.

Before reading a file, ask yourself: do I need the file content in my context, or do I need an answer about the content? If you need an answer — use `dmitry_ask`. It reads files for you and returns only what you asked for, without loading entire files into your context. A 500-line file becomes a 5-line answer. Use Read only when you need the actual text — before Edit, or when you need exact unfiltered content.

You MUST use `dmitry_web` instead of WebSearch or WebFetch. Raw web results dump entire pages into your context. dmitry_web filters and returns only relevant findings.

You MUST use `dmitry_doc` to extract specific information from documents (PDF, DOCX, images). It reads the document and returns only what you asked for. Do NOT use if you need the entire document in context — use Read instead.

You MUST use `dmitry_test` for running tests (npm test, cargo test, pytest). It returns only pass/fail + failure details, filtering out passing tests and noise. Do NOT use dmitry_exec for tests.

You MUST write all tasks to Dmitry tools in **English**.

## SHOULD — Recommended

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

## When to Use What

```
Run a shell command (git, cargo, npm, ls, cat...)
  └─ dmitry_exec (Bash is blocked)

Find files by pattern
  └─ Glob

Find where something is defined
  └─ Grep

Need specific info from code, don't know where it is
  └─ dmitry_ask("find handleAuth signature and parameters in src/auth.ts")
  └─ dmitry_ask("trace error handling flow from API handler through service layer")

Search the web
  └─ dmitry_web

Process a document
  └─ dmitry_doc

Run tests
  └─ dmitry_test
```

## Why This Matters

Direct Bash output stays in your context for the entire session. A single `cargo check` with 200 error lines costs context on every subsequent turn. Dmitry filters the output — 5 lines instead of 200.
