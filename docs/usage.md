# Usage

Run commands from the Git repository you want to work on, or pass
`--repo /path/to/project`. Each project has its own goal, conversation, and
terminal session.

## Start and return to a session

```sh
model-collab up "Fix the stale cache entries"
```

`up` initializes a new project, snapshots it, gives each agent its own worktree
under `.collab/work/`, and opens both native agent interfaces in those worktrees. In an ordinary interactive shell it attaches automatically. With
`--detach`, or when run through an agent's shell tool, it prints instructions for
attaching from your terminal.

```sh
model-collab attach
```

Repeating `up` with the same active goal reuses the session. A different active
goal must be stopped first:

```sh
model-collab stop
model-collab up "Review the retry policy"
```

Completed conversations are retained under `.collab/history/` when the next goal
starts, and the worktrees are replaced. Detaching from tmux leaves the current
session running. `stop` ends the collaboration protocol; the native interfaces
and worktrees remain available for inspection.

## The board

Agents post findings to a project board that outlives each goal: how to run the
tests, a requirement they found in the code, a dead end and why it failed, a
decision and its reason. At the start of a goal they search it. Read it with:

```sh
model-collab board threads
model-collab board search "timeout retry"
model-collab board read p12
```

Post as yourself with `model-collab board post --channel decisions "..."`, or
reply to a thread with `--thread p12`. `.collab/BOARD.md` shows the whole board.
To start fresh, delete `.collab/board.jsonl` between goals.

## Review and apply the result

When the agents converge, the agreed candidate is written to your working tree.
Review it with `git diff` and commit it yourself. If you edited any of the same
files after the session started, nothing is written; the transcript says which
files conflict. Restore or commit your edits, then run:

```sh
model-collab apply
```

When a session ends without agreement, both alternatives stay available. Inspect
them and apply the one you prefer:

```sh
model-collab diff --agent codex --candidate m2
model-collab apply --candidate m2
```

## Prepare shared context

Use `init` when you want to supply context before either agent starts:

```sh
model-collab init
```

Edit `.collab/CONTEXT.md` with the relevant architecture, constraints, file paths,
and commands. The agents also follow the repository's normal instructions.
Initialization preserves existing `AGENTS.md`, `CLAUDE.md`, and user-written
context, and adds `.collab/` to `.gitignore`.

For research work:

```sh
model-collab init --preset research
```

Fill in `.collab/RESEARCH.md` with the question, sources, current findings, and
available compute or time. The research instructions ask the agents to check
sources, distinguish assumptions from observations, and propose testable next
steps. State any experiment budget before starting work.

```sh
model-collab up "Check our rollout bootstrapping and recommend a fix"
```

You can also create a research project directly with `up --preset research`.

## Use agents you already have open

Initialize and start a goal without opening another pair of agents:

```sh
model-collab init
model-collab start "Find why the cache returns expired entries"
```

Paste this into your existing Claude Code session, using the real project path:

```text
Read /path/to/project/.collab/START-CLAUDE.md and follow it here. Work on the active shared goal in this session.
```

Paste this into Codex:

```text
Read /path/to/project/.collab/START-CODEX.md and follow it here. Work on the active shared goal in this session.
```

The generated instructions use each agent's shell tools to exchange messages.
No MCP reconfiguration is required for this workflow. `status` names each
agent's worktree; the instructions tell the agent to make its changes there, not
in the directory it was opened in. The agents wait locally
between turns; after five minutes without an actionable update, they may return
to their prompts. Say "continue collaboration" to restart an idle agent.

To launch a fresh native interface in a pane you opened yourself:

```sh
model-collab launch --agent claude
# In your other pane:
model-collab launch --agent codex
```

## Intervene

Use the control window (`Ctrl-b`, then `n`) or a separate shell:

```sh
model-collab pause
model-collab note "Keep the public API unchanged"
model-collab resume
```

A shared note reaches both peers and invalidates decisions made against earlier
instructions. Pause rejects new messages and verification results, but it cannot
interrupt a native edit already in progress. Interrupt that agent in its own
pane before making conflicting changes.

Resuming restores the remaining conversation time. An idle native agent may need
the instruction "continue collaboration". `up --resume` also resumes a paused
session when given its existing goal.

## Inspect or export the conversation

```sh
model-collab status --human
model-collab export --format markdown > discussion.md
model-collab export --format jsonl > discussion.jsonl
```

`.collab/README.md` is the readable transcript. The JSONL export is useful for
custom tooling. Both are generated from saved state; use commands to contribute
instead of editing generated history.

## Unattended sessions

```sh
model-collab up "Review the error handling in this module" --ui workers
```

Workers print contributions to the current terminal and start a CLI turn only
when a peer can contribute. They wait locally between turns and stop on agreement,
a limit, a blocker, or a transport error. When one agent's acceptance ends the
session, the other agent's turn in progress is cancelled. Ctrl-C cancels the
worker processes.

Each model turn may take up to 15 minutes by default; change this with
`--turn-timeout SECONDS`. If the protocol rejects a message, for example an
acceptance while a challenge is still open, the worker asks that agent for one
corrected message before giving up. A note you add during a turn discards that
turn's output and the agent starts again with your note.

Workers run noninteractively inside each client's sandbox, in the agent's
worktree. Codex uses `workspace-write`. Claude Code runs shell commands in its OS
sandbox, which limits writes to the worktree and temporary directories and blocks
network access. Neither agent can search the web in worker mode. Both
agents can edit files and run local tests; commands that need the network or
paths outside the worktree will fail. Workers point Go's build cache at
`.gocache` inside each worktree; other toolchains that write caches under your
home directory may need a similar setting. Use native panes when you want to
approve or direct the agents' individual tool calls.
