# Model Collab

[![Tests](https://github.com/Arth-Singh/Model-Collab/actions/workflows/test.yml/badge.svg)](https://github.com/Arth-Singh/Model-Collab/actions/workflows/test.yml)

A swarm of headless Claude Code and Codex agents works on one goal in your
repository. They divide the work among themselves over a shared chat and
integrate it on one Git branch. You get one result, applied to your working
tree.

```sh
cd your-project
model-collab up "Add a CSV export to the report command, with tests"
```

- **No roles.** Nobody is assigned a part and nobody leads. Agents claim pieces
  of the goal in `#general`, build them in their own clones, and push to a
  shared `main`. If two claims collide, the earlier message keeps the piece.
- **A real chat.** Agents talk over a local
  [SwarmChat](https://github.com/Pranjal2041/swarmchat) server: channels,
  direct messages, and threads. Watch every message live in your browser with
  `model-collab view`.
- **Git as the integration point.** A bare origin starts at a snapshot of your
  project. Agents pull, test, and push small commits. The origin refuses force
  pushes and deleted branches.
- **Fresh sessions.** Each agent runs in a loop of short sessions, so its
  context never grows without bound. An agent with nothing to do waits without
  spending tokens until a direct message, an @mention, or a post from you or the
  supervisor wakes it.
- **A clear end.** The run finishes when every agent is waiting and your
  configured checks pass on `main`. Failing checks are posted to the chat and
  wake the swarm. The result is then applied to your working tree, never over
  files you changed in the meantime.
- **Contained agents.** Agents run in each CLI's sandbox with no network and no
  web tools. API keys and tokens in your shell never reach them.

```text
user      ──► #general: Goal (run 3f9a...)
claude-1  ──► #general: I take the CSV writer: src/export/csv.js
codex-1   ──► #general: I take the CLI flag and its tests: src/cli.js, test/cli.test.js
claude-2  ──► #general: Shared tests: npm test. 42 passing on main.
...           each pushes to main, posts the commit and the test result, then waits
model-collab: every agent waiting, checks pass → result applied to your working tree
```

The rules come from what is known about swarms of coding agents and from
research on how groups go wrong. [Design](docs/design.md) explains each rule
and its source.

## Install

You need Node.js 22.12 or later, Git, SwarmChat 0.1.0, and the `codex` and
`claude` commands, signed in. macOS and Linux are supported. On Linux, Claude
Code's sandbox also needs `bubblewrap` and `socat`. This version was tested
with Codex CLI 0.165.0 and Claude Code 2.1.314.

```sh
uv tool install swarmchat==0.1.0      # or: pipx install swarmchat==0.1.0
git clone https://github.com/Arth-Singh/Model-Collab.git
cd Model-Collab
npm ci
npm link
model-collab doctor
```

`doctor` checks Node.js, Git, SwarmChat, both CLIs and the flags the agents
need, and that you are in a Git repository. It does not start a model.

The package is installed from GitHub, not npm. Keep this checkout while using
`npm link`; to update, run `git pull` and `npm ci` here.

## Run it

From the Git repository you want to work on:

```sh
model-collab up "Find why the cache returns expired entries and fix it" \
  --checks '{"test":["npm","test"]}'
```

`up` stays in the foreground and prints one line per event: sessions starting
and ending, commits on `main`, and posts in `#general`. Ctrl-C stops the run.
From another shell in the same project:

| Command                            | What it does                                                 |
| ---------------------------------- | ------------------------------------------------------------ |
| `model-collab view`                | Opens every chat in your browser, live                       |
| `model-collab status`              | Shows each agent's state, sessions, tokens, and last summary |
| `model-collab note "..."`          | Posts your instruction to `#general` and wakes every agent   |
| `model-collab stop`                | Ends the run; nothing is applied                             |
| `model-collab apply`               | Applies the latest run's result, for example after `stop`    |
| `model-collab transcript`          | Prints every chat message of the latest run                  |
| `git log refs/model-collab/result` | Shows the swarm's commits after a run ends                   |

When a run finishes, review the change with `git diff`, as you would a
colleague's patch. Configure checks: without them, a run finishes as soon as
every agent is waiting.

Give every agent background by editing `.collab/CONTEXT.md` after
`model-collab init`. Agents also follow your repository's `AGENTS.md` or
`CLAUDE.md`.

## Size, models, and limits

| Setting                | Default                          | Flag                              |
| ---------------------- | -------------------------------- | --------------------------------- |
| Agents                 | 9 Claude Code + 9 Codex          | `--agents`, `--claude`, `--codex` |
| Models                 | `claude-opus-5-5`, `gpt-6-astra` | `--claude-model`, `--codex-model` |
| Reasoning effort       | `high`                           | `--effort`                        |
| Run deadline           | 60 minutes                       | `--minutes`                       |
| One session            | 30 minutes                       | `--session-minutes`               |
| Sessions per agent     | 40                               | `--max-sessions`                  |
| Quiet period to finish | 30 seconds                       | `--quiet-seconds`                 |

Flags on `up` apply to that run. Save them for later runs with
`model-collab configure`. Eighteen agents is a lot for a small change: for a
single bug, try `--agents 2` or `--agents 4`. Every agent uses your own CLI
sign-in, so a large swarm reaches subscription usage limits sooner. See
[configuration](docs/configuration.md) for every setting.

## Does it help?

The swarm has not been evaluated yet. A smoke test, not an evaluation: one
Claude Code agent (`claude-haiku-5-5`, low effort) and one Codex agent finished
a toy `slugify` task in about two minutes, with 4 sessions and 551k tokens, and
the result was applied. Treat the swarm as an experiment and measure it on
your own work.

What is known so far comes from others. On
[ProgramBench](https://github.com/Pranjal2041/swarmchat), the SwarmChat
authors found that a team of eight reached a single agent's score three to
seven times sooner, and that one agent given enough time roughly caught up. A
team mainly buys wall-clock speed, not a higher ceiling. Their parallel
efficiency λ was 0.43 to 0.86, so extra agents add less than their share. The
[design notes](docs/design.md) cover where swarms fail: sequential tasks,
tasks without a good test suite, and many agents hitting the same bug.

The earlier version of Model Collab ran one Codex and one Claude Code agent as
a cross-examining pair. On [20 hard programming exercises](docs/evaluation.md)
the pair passed 85%, Claude Code alone passed 92%, at about three times the
cost. That evaluation measures the pair, not the swarm.

## Documentation

- [Design](docs/design.md): the research behind each swarm rule
- [How a run works](docs/protocol.md): origin, clones, chat, sessions, ending, and storage
- [Usage](docs/usage.md): running, watching, steering, and applying
- [Configuration](docs/configuration.md): every setting, checks, and the agents' environment
- [Troubleshooting](docs/troubleshooting.md): setup, usage limits, stuck runs, and conflicts
- [Evaluation](docs/evaluation.md): the earlier pair against each agent alone
- [Contributing](CONTRIBUTING.md): development setup and tests

[MIT license](LICENSE).
