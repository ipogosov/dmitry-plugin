---
name: using-dmitry
description: Use dmitry_exec MCP for ALL shell commands instead of direct Bash/Grep/Glob. Keeps context window lean by filtering command output through AI.
---

# Dmitry — Context-Aware Command Proxy

ALL shell commands MUST go through `dmitry_exec`. NEVER use direct Bash, Grep, or Glob tools.

**The only exception:** `Read` before `Edit` (you need exact file content for the old_string match).

## Tools

| Tool | When to use |
|------|-------------|
| `dmitry_exec` | ANY shell command: grep, git, find, cargo, npm, cat, wc, ls. RTK-covered commands return instantly at zero LLM cost. Short output (<10 lines) returned as-is. Long output filtered by AI. **This is your primary tool.** |
| `dmitry_ask` | One-shot investigation requiring multi-step LLM reasoning: trace call chains, compare modules, diagnose errors. Stateless, parallel-safe. NO MCP tools. NEVER send repeated queries — each ask starts from zero. |
| `dmitry_research` | Follow-up questions building on earlier findings. Full Claude CLI with ALL MCP tools (Playwright, Supabase, etc.). Context accumulates across calls. Do NOT kill between tasks. |
| `dmitry_research_kill` | Only if research agent gives clearly wrong answers or is stuck on stale context. |
| `dmitry_stats` | Usage statistics — call counts, token consumption, cost comparison. |

## Decision Tree

```
Need to run a command?
  └─ dmitry_exec (always)

Need to investigate code?
  ├─ Simple search (where is X?) → dmitry_exec("grep -rn 'X' src/")
  ├─ Complex analysis (how does module work?) → dmitry_ask
  └─ Follow-up on prior investigation → dmitry_research

Need exact file content before Edit?
  └─ Read directly (only exception)
```

## Why This Matters

Direct Bash/Grep output stays in your context for the entire session. A single `cargo check` with 200 error lines costs you context on every subsequent turn. Dmitry filters the output — you get 5 lines instead of 200. Over a session, this is the difference between running out of context and staying productive.

## Language

Always write tasks to Dmitry in **English**. Output goes to another LLM, not a human.
