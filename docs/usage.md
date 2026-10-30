# Usage

Run commands from the Git repository you want to work on, or pass
`--repo /path/to/project`. Each project has its own settings, chat, and runs.

## Start a run

```sh
model-collab up "Add retries to the HTTP client, with tests" \
  --checks '{"test":["npm","test"]}'
```

`up` creates `.collab/` with default settings the first time, snapshots the
project, gives each agent a clone of a shared origin, starts the chat, posts
your goal to `#general`, and starts the agents a few seconds apart. It stays in
the foreground until the run ends and prints one line per event:

```text
14:02:11 Run 3f9a... started with 18 agents.
14:02:11 claude-1 starts session 1
14:03:40 #general claude-1: I take the retry policy: src/http/retry.js
14:09:02 main 4f2a91c1 claude-1: Add exponential backoff with jitter
14:09:30 claude-1 → wait (439s, 812k tokens): Retry policy pushed; tests pass.
```

The goal can also come from a file (`@goal.md`) or standard input (`-`). Add
success criteria with `--criteria "Retries stop after 5 attempts" "..."`.

Flags on `up` apply to this run only; see [configuration](configuration.md) to
save them. Choose the swarm's size for the task: a small fix needs two to four
agents, not eighteen.

```sh
model-collab up "Fix the flaky date test" --agents 2 --minutes 20
```

Keep the computer awake during a run. On macOS, run
`caffeinate -i model-collab up ...` and keep the lid open.

## Watch

```sh
model-collab view
```

opens SwarmChat's viewer in your browser: every channel and direct message,
threads, a board view of a channel, a map of who talks to whom, and the chat as
any one agent sees it. `--no-open` prints the address instead. The viewer only
reads; it moves no one's read position.

From another shell:

```sh
model-collab status        # each agent's state, sessions, tokens, last summary
model-collab status --json # the full state, for tools
model-collab transcript    # every message of the latest run, oldest first
```

Agent states are `starting`, `working` (in a session), `waiting` (asleep until
a message reaches it), `backoff` (after a failed session), `retired`, and
`stopped`.

## Monitor growth with TensorBoard

Every run writes TensorBoard scalars, sampled every 15 seconds, to
`.collab/tensorboard/<start>_<N>agents_<goal>/`. The step is seconds since the
run started.

```sh
model-collab tensorboard   # serves http://127.0.0.1:6006; --port to change
```

You need TensorBoard itself: `uv tool install tensorboard`. TensorBoard reloads
while a run writes, so you can watch a run grow live and compare earlier runs.
To send every project's runs to one board, set an absolute folder in your
shell profile; a project's own `tensorboardDir` setting still wins:

```sh
export MODEL_COLLAB_TENSORBOARD_DIR="$HOME/model-collab-runs/tensorboard"
tensorboard --logdir "$MODEL_COLLAB_TENSORBOARD_DIR"
```

| Group            | Scalars                                                               |
| ---------------- | --------------------------------------------------------------------- |
| `main`           | commits, files and lines changed since the start, distinct committers |
| `progress`       | `score` and `score_fraction` from your score command                  |
| `checks`         | `passed_fraction` of each check round                                 |
| `agents`         | how many agents are starting, working, waiting, in backoff, retired   |
| `sessions`       | total, failed, and rate-limited sessions                              |
| `tokens`, `cost` | input, cached input, output, per CLI, and Claude Code's reported cost |
| `chat`           | messages in total, in `#general`, and direct                          |
| `machine`        | load average, free memory, and the agents' resident memory            |
| `agent_*`        | tokens, sessions, and commits for each agent                          |

The score is the measure of growth. Give a command that prints how far `main`
has come; the supervisor runs it on `main` in a clean checkout every 2 minutes
and on the final `main`, and plots the last `x/y` (or number) it prints. Agents
never run it, and the final score is in `model-collab status`:

```sh
model-collab up "Implement SPEC.md" --agents 8 \
  --score '["python3","-m","pytest","-q","tests/acceptance"]' --score-seconds 60
```

A score command can read files outside the repository, such as held-out tests.
Agents cannot reach the network, but they can read files, so keep tests out of
their reach if they must stay hidden; see [the trust boundary](protocol.md).
To log nothing, pass `--tensorboard off`.

## Steer

```sh
model-collab note "Keep the public API of client.get unchanged"
```

posts your instruction to `#general` as `user`. Any post from you wakes every
waiting agent, unlike an agent's plain post in `#general`. A note can also come
from a file (`@note.md`) or standard input (`-`).

```sh
model-collab stop "Wrong approach; I will restate the goal"
```

asks the supervisor to end the run within a few seconds. Sessions in progress
are stopped and nothing is applied. Ctrl-C in the terminal running `up` does
the same; a second Ctrl-C quits at once.

## Review and apply the result

A run that finishes applies its result to your working tree. Review it with
`git diff` and commit it yourself. The swarm's own commits are in
`refs/model-collab/result`:

```sh
git log --oneline HEAD..refs/model-collab/result
```

If you edited any of the same files during the run, nothing is written and
`model-collab status` names them. Commit, stash, or restore your edits, then
run:

```sh
model-collab apply
```

`apply` also takes the result of a run that expired, was stopped, or failed,
for example when its checks failed for a reason you accept. Look at it first:

```sh
git diff HEAD refs/model-collab/result
model-collab apply
```

## Shared context

```sh
model-collab init
```

creates `.collab/` without starting a run and adds `.collab/` to the
repository's local exclude file (`.git/info/exclude`), so no tracked file changes. Edit `.collab/CONTEXT.md` with the architecture, constraints,
relevant paths, and commands every agent should know. Agents also follow the
repository's `AGENTS.md` or `CLAUDE.md`.

For research work, use the `research` preset. Agents then also follow the
research contract: state claims precisely, check sources, separate observation
from interpretation, and plan bounded experiments. `init --preset research`
also creates `.collab/RESEARCH.md`; fill in the question, sources, findings so
far, and the experiment budget, and every agent reads it.

```sh
model-collab init --preset research
```

## Project memory

When a run ends, Model Collab condenses it into `.collab/MEMORY.md`: what you
asked for and corrected, how to build and test, traps, and what was decided.
Every agent reads it in later runs, and is told to verify it rather than trust
it.

```sh
model-collab memory show
```

Edit the file to correct it; your edits survive later updates. See
[configuration](configuration.md#project-memory) to update, clear, or turn it
off.
