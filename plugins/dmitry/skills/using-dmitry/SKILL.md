---
name: using-dmitry
description: Route ALL shell commands through dmitry_exec. Use dmitry_ask for code investigation, dmitry_web for multi-step web research (returns inventory of pages — you pick what to read), dmitry_doc for documents, dmitry_test for tests, Read for exact file content.
---

# Dmitry — Context-Aware Command Proxy

Bash, Grep, and Glob are blocked at the PreToolUse hook. Route through Dmitry MCP tools instead. Read and Edit are not blocked.

## Tools

| Tool | Type | What it does |
|------|------|-------------|
| `dmitry_exec` | one-shot | Any shell command (git, npm, ls, cat, find, grep, wc). RTK-covered commands run instantly with zero LLM cost; long output is filtered through Haiku. |
| `dmitry_ask` | persistent | Cross-file code investigation: trace calls, find usages, locate symbols. Returns locations (file:line), not summaries. **Context accumulates across calls** — group related questions; use `dmitry_ask_kill` to reset. |
| `dmitry_test` | one-shot | Run tests (npm test, cargo test, pytest). Returns only pass/fail + failure details. Do not add `--verbose` to "see more" — there is no more. |
| `dmitry_doc` | one-shot | Extract specific info from PDF/DOCX/image. Do NOT use if you need the full document in context — use Read instead. |
| `dmitry_web` | one-shot | Multi-step web research. Returns an INVENTORY of pages (URL + kind + headings + literal excerpt) — you pick what to fetch. Does NOT judge which page has the right answer. |

## Routing

```
Run a shell command           → dmitry_exec
Find a symbol / string        → dmitry_exec("grep -rn 'pat' path")   # RTK = instant
Find files by name            → dmitry_exec("find . -name '*.ts'")   # RTK = instant
Understand code across files  → dmitry_ask
Edit a known file             → Read → Edit
Run tests                     → dmitry_test
Extract from a document       → dmitry_doc
Single known URL              → WebFetch (yourself)
Single keyword search         → WebSearch (yourself)
Multi-step web research       → dmitry_web
```

## Rules

- Never use `dmitry_ask` for design or trade-off decisions — those are yours, not Haiku's.
- Use `dmitry_ask` instead of `Agent(Explore)` for codebase investigation — it's persistent, cached, and cheaper.
- Use `dmitry_web` only when you need 2+ searches or don't know which page has the answer. For a single known URL or one obvious search, use WebFetch/WebSearch yourself.
- Write all task descriptions to Dmitry tools in **English**.
