# Contributing

## Development setup

Use Node.js 22.12 or later, Git, and SwarmChat 0.1.0
(`uv tool install swarmchat==0.1.0`). Tests that need a chat server skip when
`swarmchat` is missing.

```sh
npm ci
npm run check
npm run format:check
npm test
```

Tests use local fixtures. They do not invoke models or require CLI
authentication: supervisor tests replace agent sessions with scripted
functions, and the CLI test puts fake `claude` and `codex` executables on PATH.
They start real SwarmChat servers on free localhost ports. CI installs
SwarmChat with pipx and runs on Linux and macOS with Node.js 22 and 24.

Run `npm run format` to apply the repository's formatting conventions.

## Project structure

- `bin/` contains the CLI.
- `src/swarm.js` supervises a run: setup, agent session loops, waking, ending,
  checks, and applying.
- `src/agent.js` runs one headless Claude Code or Codex session with its
  sandbox flags and allowlisted environment, and parses its result and usage.
- `src/chat.js` starts SwarmChat, provisions users, and wraps its CLI.
- `src/workspace.js` captures the snapshot, creates the origin and agent
  clones, runs checkouts for checks, and applies the result.
- `src/store.js` keeps `.collab/state.json`, its lock, and run history.
- `src/server.js` is each agent's MCP server: the `chat_*` and `swarm_*` tools.
- `src/memory.js` condenses finished runs into project memory.
- `src/schema.js` validates settings and goals.
- `src/process.js` runs processes with time and output limits;
  `src/doctor.js` checks the setup.
- `src/display.js` renders events, status, and results for people.
- `prompts/` contains the swarm and research contracts; `docs/design.md`
  explains them.
- `schemas/` documents the settings format.
- `test/` covers each module and full runs with fixture processes.
- `eval/polyglot/` is the evaluation harness behind
  [docs/evaluation.md](docs/evaluation.md). It calls real models and costs
  money; `npm test` never runs it.

Preserve existing project context and native client settings. New commands should
show useful errors, never leave agent processes or chat servers running, and
keep machine-readable interfaces stable. Changes to how a run starts, wakes
agents, or ends need tests for the failure paths as well as the successful
ones.

User-facing documentation belongs in the README and `docs/`. The package is
installed from GitHub rather than npm, but `files` in `package.json` still
defines what `npm pack` includes; check it with `npm pack --dry-run` when you
add a top-level directory. The evaluation harness stays out of the package.

## Reporting a problem

Include your operating system, Node.js and client versions, the command that
failed, and the error text. A short redacted transcript is useful for conversation
issues; `model-collab transcript` prints one. Remove credentials and private
project content before opening an issue.
