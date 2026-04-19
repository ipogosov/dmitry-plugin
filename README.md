# Dmitry

Every shell command you run dumps raw output into Claude's context. It stays there for the rest of the session. 200 lines of `cargo check` errors, repeated on every turn, until context runs out.

Dmitry filters that output before it reaches you.

## What it does

One plugin. Eight tools. Each knows its job.

- **exec** — run any shell command, get filtered output
- **ask** — persistent agent for code investigation
- **task** — delegate mechanical code work to a Sonnet/Opus subagent (replaces native Task)
- **web** — multi-step web scout, returns an inventory of pages to pick from
- **doc** — process a document, extract what matters
- **test** — run tests, return only failures
- **ask_kill** — reset the persistent agent
- **stats** — see what you saved

### Delegation

`dmitry_task` spawns a fresh Claude session (Sonnet by default, Opus on demand, optional 1M-context mode) that runs the job in its own context and returns only the result. Built-in cancel protocol, per-dispatch timeout, heartbeat, partial-result recovery. The parent keeps its context clean — a 120-turn investigation by the subagent doesn't cost 120 turns of parent baseline re-reads.

## Install

```
claude plugin marketplace add ipogosov/dmitry-plugin
claude plugin install dmitry@dmitry-plugin
```

Restart your session.

## How it works

The plugin installs an MCP server, a skill, and hooks.

The skill tells Claude to route commands through Dmitry. The hooks enforce it: Bash, Grep, Glob, and the native Task tool are blocked — Claude must use `dmitry_exec` for shell and single-pattern search, `dmitry_ask` for semantic/bulk investigation, and `dmitry_task` for delegation. Read and Edit are never blocked.

Compatible with [RTK](https://github.com/rtk-ai/rtk). RTK-covered commands (git, grep, find, cargo, npm) are detected and routed through RTK automatically — instant response, zero LLM cost. Long output goes through Haiku for filtering. You get 5 lines instead of 200.

## What stats shows

`dmitry_stats today|week|all` groups calls into three buckets, each with its own savings model:

- **filter** (exec/test) — the raw-stdout displacement you avoided caching in the parent.
- **research** (ask/web/doc) — Haiku doing the reasoning Opus would otherwise do inline.
- **delegation** (task) — subagent turns that would have been parent turns, each re-reading the orchestrator's baseline context.

Savings are reported across three parent-turn horizons (3 / 15 / 50) because a token saved in turn 1 stays in parent cache for the rest of the session — the longer the session, the bigger the compounded gain. The model explicitly prices MCP dispatch overhead on the delegation side, so numbers represent net value, not gross. What it does *not* price: compact-prevention (step function), parallelism (wall-clock), and Opus-vs-Sonnet token-efficiency gap.

## Requirements

- **Claude Code CLI** (Max subscription or API key)
- **Node.js 18+**
- **RTK** — optional but recommended. Without it, commands still work but skip instant-routing
- **Windows**: Git for Windows (for bash in hooks)
