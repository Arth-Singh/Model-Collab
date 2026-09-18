# Contributing

## Development setup

Use Node.js 22.12 or later. tmux is needed for the terminal integration test.

```sh
npm ci
npm run check
npm run format:check
npm test
```

Tests use local fixtures. They do not invoke models or require CLI authentication.
The tmux test creates and removes its own session, and skips when tmux is missing.
CI runs on Node.js 22 and 24.

Run `npm run format` to apply the repository's formatting conventions.

## Project structure

- `bin/` contains the CLI.
- `src/core.js` owns state transitions, file claims, and verification.
- `src/up.js`, `src/setup.js`, and `src/control.js` manage native terminal sessions.
- `src/worker.js` runs unattended turns.
- `src/server.js` exposes the MCP interface.
- `prompts/` contains the peer instructions.
- `schemas/` documents configuration and message formats.
- `test/` covers the protocol and integrations with fixture processes.

Preserve existing project context and native client settings. New commands should
show useful errors, avoid starting duplicate agents, and keep machine-readable
interfaces stable. Changes to state transitions need tests for rejected actions
as well as successful ones.

Run `npm pack --dry-run` before changing package contents. User-facing documentation
belongs in the README and `docs/`; keep internal research artifacts out of the
published package.

## Reporting a problem

Include your operating system, Node.js and client versions, the command that
failed, and the error text. A short redacted transcript is useful for conversation
issues. Remove credentials and private project content before opening an issue.
