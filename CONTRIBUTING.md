# Contributing

## Development setup

Use Node.js 22.12 or later and Git. tmux is needed for the terminal integration test.

```sh
npm ci
npm run check
npm run format:check
npm test
```

Tests use local fixtures. They do not invoke models or require CLI authentication.
The tmux test creates and removes its own session, and skips when tmux is missing.
CI runs on Linux and macOS with Node.js 22 and 24.

Run `npm run format` to apply the repository's formatting conventions.

## Project structure

- `bin/` contains the CLI.
- `src/core.js` owns state transitions, votes, verification, and applying.
- `src/schema.js` validates configuration, messages, and board input.
- `src/workspace.js` creates worktrees, snapshots candidates, and builds checkouts.
- `src/board.js` stores, filters, and pages the project board.
- `src/memory.js` condenses finished goals into project memory.
- `src/up.js`, `src/setup.js`, and `src/control.js` manage native terminal sessions.
- `src/worker.js` runs unattended turns; `src/native.js` runs the agent CLIs for it.
- `src/process.js` runs configured checks and `src/doctor.js` checks the setup.
- `src/server.js` exposes the MCP interface.
- `src/display.js` renders status, transcripts, and board output for people.
- `prompts/` contains the peer instructions; `docs/design.md` explains them.
- `schemas/` documents configuration and message formats.
- `test/` covers the protocol and integrations with fixture processes.
- `eval/polyglot/` is the evaluation harness behind
  [docs/evaluation.md](docs/evaluation.md). It calls real models and costs
  money; `npm test` never runs it.

Preserve existing project context and native client settings. New commands should
show useful errors, avoid starting duplicate agents, and keep machine-readable
interfaces stable. Changes to state transitions need tests for rejected actions
as well as successful ones.

User-facing documentation belongs in the README and `docs/`. The package is
installed from GitHub rather than npm, but `files` in `package.json` still
defines what `npm pack` includes; check it with `npm pack --dry-run` when you
add a top-level directory. The evaluation harness stays out of the package.

## Reporting a problem

Include your operating system, Node.js and client versions, the command that
failed, and the error text. A short redacted transcript is useful for conversation
issues. Remove credentials and private project content before opening an issue.
