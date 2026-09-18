# Model Collab

[![Tests](https://github.com/Arth-Singh/Model-Collab/actions/workflows/test.yml/badge.svg)](https://github.com/Arth-Singh/Model-Collab/actions/workflows/test.yml)

Run Codex and Claude Code together in your terminal.

Give them a goal in your repository. Each agent investigates independently, then
shares a proposal, reviews the other's work, and works toward an agreed solution.
Both keep their native interfaces, so you can follow their edits and interrupt at
any time.

```sh
cd your-project
model-collab up "Find why the cache returns expired entries and fix it"
```

## Install

You need Node.js 22.12 or later, tmux, and the `codex` and `claude` commands.
Sign in to both agents before starting. The terminal workflow supports macOS and
Linux, including iTerm2 on macOS.

```sh
git clone https://github.com/Arth-Singh/Model-Collab.git
cd Model-Collab
npm ci
npm link
model-collab doctor
```

Installation is from GitHub; the package is not published on npm. Keep this
checkout while using `npm link`. To update, run `git pull` and `npm ci` here.

## Start a session

Run `up` from the repository you want the agents to work on:

```sh
model-collab up "Find the cause of our failing integration test"
```

This creates a project-local `.collab/` directory and opens Codex and Claude in
two tmux panes. Both receive the goal and collaboration instructions automatically.
A separate control window lets you pause, add a shared instruction, or stop.
With tmux's default key bindings:

| Action                               | Shortcut           |
| ------------------------------------ | ------------------ |
| Switch between agents                | `Ctrl-b`, then `o` |
| Open the control window              | `Ctrl-b`, then `n` |
| Detach and leave the session running | `Ctrl-b`, then `d` |

Return to the session later with:

```sh
model-collab attach
```

When launched through an agent's shell tool, `up` prints an attach command for
your terminal. It opens new panes. See [existing sessions](docs/usage.md#use-agents-you-already-have-open)
if you want to keep conversations already running in iTerm2.

## Give both agents context

The agents can read your repository and its existing `AGENTS.md` or `CLAUDE.md`.
For shared background, initialize before starting and edit `.collab/CONTEXT.md`:

```sh
model-collab init
# Add relevant paths, constraints, and test commands to .collab/CONTEXT.md.
model-collab up "Fix the regression described in our shared context"
```

For research, use the research preset. It adds a brief for your question, sources,
assumptions, and experiment budget:

```sh
model-collab init --preset research
# Fill in .collab/RESEARCH.md.
model-collab up "Review our PPO implementation and propose the next experiment"
```

## Steer the work

In the control window, type `pause`, `note <instruction>`, `resume`, or `stop`.
You can also use another shell in the same project:

```sh
model-collab pause
model-collab note "Keep the public API unchanged"
model-collab resume
```

Pause stops new collaboration actions. Interrupt an ongoing edit in the agent's
own pane before changing the same files yourself. After resuming, tell an idle
agent to "continue collaboration".

The conversation is saved in `.collab/README.md`. For a quick summary:

```sh
model-collab status --human
```

## Models and session limits

Defaults are `gpt-6-astra` for Codex and `claude-fable-5-1[1m]` for Claude Code,
both with `xhigh` effort. Override them with model IDs available to your account:

```sh
model-collab up "Review this change" \
  --codex-model YOUR_CODEX_MODEL \
  --claude-model YOUR_CLAUDE_MODEL \
  --effort high
```

New projects allow four discussion rounds and 30 minutes. Agents must supply
concrete evidence and explicitly accept the same proposal to finish in agreement.
Unresolved work stays unresolved when the limits expire.

For code changes, you can require a project check before acceptance:

```sh
model-collab up "Fix the failing tests" \
  --checks '{"test":["python","-m","pytest","-q"]}'
```

Existing projects retain their saved settings. See [configuration](docs/configuration.md)
for limits, checks, and alternate workflows.

## Documentation

- [Usage](docs/usage.md): existing panes, project context, and unattended sessions
- [Configuration](docs/configuration.md): models, limits, checks, and CLI options
- [Troubleshooting](docs/troubleshooting.md): setup, stalled agents, and reconnecting
- [Protocol](docs/protocol.md): message format and file coordination
- [Contributing](CONTRIBUTING.md): development setup and tests

[MIT license](LICENSE).
