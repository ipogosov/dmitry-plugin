---
name: using-dmitry
description: Route ALL shell commands through dmitry_exec. Use dmitry_ask for code investigation, dmitry_web for search, dmitry_doc for documents, dmitry_test for tests, Read for exact file content.
---

# Dmitry — Context-Aware Command Proxy

<EXTREMELY-IMPORTANT>
NEVER use Bash, Grep, or Glob tools directly. Route ALL commands through dmitry_exec.

Read tool is the ONLY exception — use it freely when you need exact file content.

This is not optional. Every direct Bash call dumps raw output into your context for the rest of the session.
</EXTREMELY-IMPORTANT>

## Tools

| Tool | Type | What it does |
|------|------|-------------|
| `dmitry_exec` | direct | Run any shell command with filtered output. Your primary tool. |
| `dmitry_ask` | persistent | Code investigation: trace calls, find usages, compare modules. Context accumulates across calls. |
| `dmitry_web` | one-shot | Search the web or fetch a page. Parallel-safe. |
| `dmitry_doc` | one-shot | Process document (PDF/DOCX/MD/image), extract specific info. Parallel-safe. |
| `dmitry_test` | one-shot | Run tests, return only pass/fail + failures. |
| `dmitry_ask_kill` | — | Kill persistent ask agent. Only if stuck on stale context. |
| `dmitry_stats` | — | Usage statistics and cost comparison. |
| `Read` | built-in | Read exact file content. Before Edit, or when you need full unfiltered content. |

## When to Use What

```
Run a command (git, grep, find, cargo, npm, ls, cat...)
  └─ dmitry_exec

Find something in code
  ├─ "Where is X defined?" → dmitry_exec("grep -rn 'X' src/")
  └─ "How does module X work?" → dmitry_ask

Search the web
  └─ dmitry_web("find React 19 migration guide")

Process a document
  └─ dmitry_doc("/path/to/spec.pdf", "find API rate limits section")

Run tests
  └─ dmitry_test("npm test")

Need exact file content
  └─ Read — specs, configs, prompts, files before Edit
```

## Red Flags — Stop and Rethink

| You're about to... | Do this instead |
|---------------------|----------------|
| Call Bash directly | dmitry_exec |
| Call Grep directly | dmitry_exec("grep ...") |
| Call Glob directly | dmitry_exec("find ...") |
| Use `cat` to read a file for editing | Read |
| Search the web via Bash curl | dmitry_web |
| Read a PDF to find one section | dmitry_doc |
| Run tests via dmitry_exec | dmitry_test — filters noise |
| Ask dmitry_ask to "recommend" or "decide" | Think yourself — ask gathers data, you decide |

## Why This Matters

Direct Bash/Grep output stays in your context for the entire session. A single `cargo check` with 200 error lines costs context on every subsequent turn. Dmitry filters the output — 5 lines instead of 200.

## Language

Always write tasks to Dmitry in **English**. Output goes to another LLM, not a human.
