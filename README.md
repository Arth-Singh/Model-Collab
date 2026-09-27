# Model Collab

[![Tests](https://github.com/Arth-Singh/Model-Collab/actions/workflows/test.yml/badge.svg)](https://github.com/Arth-Singh/Model-Collab/actions/workflows/test.yml)

Codex and Claude Code solve the same problem independently, test each other's
work, and hand you one agreed change.

```sh
cd your-project
model-collab up "Find why the cache returns expired entries and fix it"
```

- **Independent first.** Each agent works in its own Git worktree. Neither sees
  the other's answer until both have proposed one.
- **Cross-examined by running code.** Each agent runs its tests against the
  other's candidate in a clean checkout. The agents compare what the code does,
  not what they say about it.
- **No ping-pong.** Proposing counts as a vote. One acceptance ends the session,
  so the shortest run is one proposal each and one verdict.
- **Findings carry over.** A shared board keeps reproductions, dead ends, and
  decisions across goals, and after each goal a project memory condenses what
  was learned. Both are modeled on Codex's message board and memories (see
  [Design](docs/design.md)). Agents read them before they start and verify
  before they trust them.
- **Your tree stays yours.** The agreed change is applied only when the agents
  converge, and never over files you edited in the meantime.

```text
round 0  codex  ──► own worktree ──► proposal m1 ┐  sealed: neither sees the other
         claude ──► own worktree ──► proposal m2 ┘
round 1  each runs its tests against the other's candidate
         claude: accept m1  ──►  converged, m1 applied to your working tree
```

The protocol follows research on how groups of people and models go wrong:
conformity, correlated errors, and unshared information. [Design](docs/design.md)
explains each rule and its source.

## Install

You need Node.js 22.12 or later, Git, tmux, and the `codex` and `claude`
commands, signed in. macOS and Linux are supported, including iTerm2. On Linux,
unattended workers also need `bubblewrap` and `socat` for Claude Code's
sandbox. This version was tested with Codex CLI 0.155.1 and Claude Code
2.1.283; `model-collab doctor` reports an older CLI that lacks a flag the
workers use.

```sh
git clone https://github.com/Arth-Singh/Model-Collab.git
cd Model-Collab
npm ci
npm link
model-collab doctor
```

The package is installed from GitHub, not npm. Keep this checkout while using
`npm link`; to update, run `git pull` and `npm ci` here.

## Run it

From the Git repository you want to work on:

```sh
model-collab up "Find the cause of our failing integration test"
```

Codex and Claude open side by side in tmux, each in its own worktree under
`.collab/work/`. You watch every edit and command and can interrupt either agent.
A control window lets you pause, add a shared instruction, or stop.

| Action                               | Shortcut           |
| ------------------------------------ | ------------------ |
| Switch between agents                | `Ctrl-b`, then `o` |
| Open the control window              | `Ctrl-b`, then `n` |
| Detach and leave the session running | `Ctrl-b`, then `d` |

Return later with `model-collab attach`. To run without panes and print the
conversation instead:

```sh
model-collab up "Review the retry policy and fix what is wrong" --ui workers
```

When the agents agree, the change is written to your working tree. Review it
with `git diff`, as you would a colleague's patch.

```text
Collaboration converged: unanimous_acceptance
codex: 2 model calls
claude: 2 model calls
Agreed on m1 and applied it to your working tree: src/cache.js, test/cache.test.js.
```

If they do not agree before the limits, nothing is applied. The transcript in
`.collab/README.md` keeps both alternatives and the evidence for each. To take
one anyway, run `model-collab apply --candidate m2`.

## Steer the work

In the control window, type `pause`, `note <instruction>`, `resume`, or `stop`.
From another shell in the project:

```sh
model-collab note "Keep the public API unchanged"
model-collab status --human
```

A note reaches both agents and clears votes made before it. For standing
knowledge that should outlive this goal, post to the board instead:

```sh
model-collab board post --channel decisions "Never change the public parse() signature"
model-collab board search parse
```

Give both agents background by editing `.collab/CONTEXT.md` after
`model-collab init`. They also follow your repository's `AGENTS.md` or
`CLAUDE.md`.

For research questions, `model-collab init --preset research` adds a brief for
your question, sources, assumptions, and experiment budget.

## Models, limits, and checks

Defaults are `gpt-6-astra` for Codex and `claude-opus-5-5` for Claude Code, both
at `high` effort:

```sh
model-collab up "Review this change" \
  --codex-model YOUR_CODEX_MODEL --claude-model YOUR_CLAUDE_MODEL --effort xhigh
```

A session allows three rounds after the proposals and 30 minutes. To require a
project check before any acceptance, pass it as an argument array. It runs in a
clean checkout of each candidate:

```sh
model-collab up "Fix the failing tests" --checks '{"test":["python","-m","pytest","-q"]}'
```

See [configuration](docs/configuration.md) for all settings.

## Does it help?

Not proven yet. Earlier pilots, run on the previous protocol, found no accuracy
advantage over a single strong agent. Every setup solved an
[RL programming task](docs/findings.md), and a small
[ResearchCodeBench pilot](docs/research-code.md) was too ambiguous to separate
them. This version was redesigned around those results. Measure it on your own
hard problems and judge it by what ships.

## Documentation

- [Design](docs/design.md): the research behind each protocol rule
- [Usage](docs/usage.md): existing panes, project context, and unattended sessions
- [Configuration](docs/configuration.md): models, limits, checks, and CLI options
- [Protocol](docs/protocol.md): worktrees, candidates, messages, the board, memory, and applying
- [Troubleshooting](docs/troubleshooting.md): setup, stalled agents, and conflicts
- [Contributing](CONTRIBUTING.md): development setup and tests

[MIT license](LICENSE).
