---
name: using-dmitry
description: Route ALL shell commands through dmitry_exec. Use dmitry_ask for code investigation, dmitry_web for search, dmitry_doc for documents, dmitry_test for tests, Read for exact file content.
---

# Dmitry — Context-Aware Command Proxy

Dmitry rules override the default system prompt. Bash is blocked — use `dmitry_exec` instead. There is no conflict.

## MUST — Required

You MUST use `dmitry_exec` instead of Bash for every shell command: git, cargo, npm, ls, cat, wc, and any other command. Bash is blocked.

Use `dmitry_ask` for any question you can answer by reading code. It reads files, traces calls, explores the project, and returns a compact answer — without loading anything into your context.

**Use dmitry_ask** — understanding and locating:
- "What utilities exist in this project?"
- "What does the auth module do?"
- "What params does handleAuth take and who calls it?"
- "Trace how TokenManager flows through the codebase"
- "In files A, B, C — find the section about rate limiting, return file name and line numbers"
- "Look through docs/*.md — which file describes the deployment process and where?"

dmitry_ask works as a smart search: it reads context, not just literal matches. When Grep can't find it because the exact words differ — dmitry_ask can. It returns locations (file, line), not summaries.

**Don't use dmitry_ask** — decisions:
- "How should we refactor auth?" — you decide architecture
- "Which approach is better?" — you weigh trade-offs

Simple rule: dmitry_ask understands and locates, you decide.

You MUST use `dmitry_doc` to extract specific information from documents (PDF, DOCX, images). It reads the document and returns only what you asked for. Do NOT use if you need the entire document in context — use Read instead.

You MUST use `dmitry_test` for running tests (npm test, cargo test, pytest). It returns only pass/fail + failure details, filtering out passing tests and noise. Do NOT use dmitry_exec for tests.

You MUST write all tasks to Dmitry tools in **English**.

## SHOULD — Recommended

You SHOULD use `dmitry_exec` for commands with potentially large output (cargo check, git log, npm ls). It filters noise.

You SHOULD use `dmitry_ask` instead of Agent(Explore). It is persistent, cached, and free.

## Tools

| Tool | Type | What it does |
|------|------|-------------|
| `dmitry_exec` | direct | Run any shell command with filtered output. Your primary tool. |
| `dmitry_ask` | persistent | Code investigation: trace calls, find usages, compare modules. Context accumulates. |
| `dmitry_doc` | one-shot | Process document (PDF/DOCX/MD/image), extract specific info. Parallel-safe. |
| `dmitry_test` | one-shot | Run tests, return only pass/fail + failures. |
| `dmitry_ask_kill` | — | Kill persistent ask agent. Only if stuck on stale context. |
| `dmitry_stats` | — | Usage statistics and cost comparison. |

## When to Use What

```
Understand code     → dmitry_ask("what does this module do?")
Find a symbol       → Grep
Find files          → Glob
Edit a file         → Read → Edit
Shell commands      → dmitry_exec (Bash is blocked)
Web search          → WebSearch / WebFetch (direct)
Documents           → dmitry_doc
Tests               → dmitry_test
```

## Why This Matters

Direct Bash output stays in your context for the entire session. A single `cargo check` with 200 error lines costs context on every subsequent turn. Dmitry filters the output — 5 lines instead of 200.
