# Dmitry

Every shell command you run dumps raw output into Claude's context. It stays there for the rest of the session. 200 lines of `cargo check` errors, repeated on every turn, until context runs out.

Dmitry filters that output before it reaches you.

## What it does

One plugin. Seven tools. Each knows its job.

- **exec** — run any shell command, get filtered output
- **ask** — persistent agent for code investigation
- **web** — search the web, return findings
- **doc** — process a document, extract what matters
- **test** — run tests, return only failures
- **ask_kill** — reset the persistent agent
- **stats** — see what you saved

## Install

```
claude plugin marketplace add ipogosov/dmitry-plugin
claude plugin install dmitry@dmitry-plugin
```

Restart your session.

## How it works

The plugin installs an MCP server, a skill, and hooks.

The skill tells Claude to route commands through Dmitry. The hooks enforce it — first violation is blocked, then gentle reminders. Read tool is never blocked.

Compatible with [RTK](https://github.com/obra/rtk). RTK-covered commands (git, grep, find, cargo, npm) are detected and routed through RTK automatically — instant response, zero LLM cost. Long output goes through Haiku for filtering. You get 5 lines instead of 200.

## Requirements

- **Claude Code CLI** (Max subscription or API key)
- **Node.js 18+**
- **RTK** — optional but recommended. Without it, commands still work but skip instant-routing
- **Windows**: Git for Windows (for bash in hooks)
