---
name: using-dmitry
description: Route ALL shell commands through dmitry_exec, use dmitry_research for LLM reasoning, use Read for exact file content. Keeps context lean.
---

# Dmitry — Context-Aware Command Proxy

<EXTREMELY-IMPORTANT>
NEVER use Bash, Grep, or Glob tools directly. Route ALL commands through dmitry_exec.

Read tool is the ONLY exception — use it freely when you need exact file content.

This is not optional. Every direct Bash call dumps raw output into your context for the rest of the session.
</EXTREMELY-IMPORTANT>

## Tools

| Tool | What it does | When to use |
|------|-------------|-------------|
| `dmitry_exec` | Runs any shell command with filtered output | ANY command: grep, git, find, cargo, npm, cat, ls. Your primary tool. |
| `dmitry_research` | Persistent Haiku agent with full MCP access | When you need LLM reasoning: trace code, analyze architecture, compare modules, diagnose errors. Context accumulates — do NOT kill between tasks. |
| `dmitry_research_kill` | Kills research agent | Only if research gives wrong answers from stale context. |
| `dmitry_stats` | Usage statistics | Call counts, token consumption, cost comparison. |
| `Read` | Read exact file content | Before Edit. Reading specs, configs, docs you need to fully understand. Any time you need raw unfiltered content. |

## When to Use What

```
Run a command (git, grep, find, cargo, npm, ls, cat...)
  └─ dmitry_exec — always

Find something in code
  ├─ "Where is X defined?" → dmitry_exec("grep -rn 'X' src/")
  └─ "How does module X work?" → dmitry_research

Need to understand a document fully
  └─ Read — specs, configs, prompts, memory files

Need exact file content before editing
  └─ Read — then Edit

Need LLM to reason across multiple files
  └─ dmitry_research
```

## Red Flags — Stop and Rethink

| You're about to... | Do this instead |
|---------------------|----------------|
| Call Bash directly | dmitry_exec |
| Call Grep directly | dmitry_exec("grep ...") |
| Call Glob directly | dmitry_exec("find ...") |
| Use `cat` to read a file for editing | Read |
| Send repeated exec calls exploring blindly | dmitry_research — one task, full answer |
| Read a large file just to find one thing | dmitry_exec("grep ...") or dmitry_research |

## Why This Matters

Direct Bash/Grep output stays in your context for the entire session. A single `cargo check` with 200 error lines costs context on every subsequent turn. Dmitry filters the output — 5 lines instead of 200.

## Language

Always write tasks to Dmitry in **English**. Output goes to another LLM, not a human.
