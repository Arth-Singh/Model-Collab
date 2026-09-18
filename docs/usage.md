# Usage

Run commands from the project you want to work on, or pass `--repo /path/to/project`.
Each project has its own goal, conversation, and terminal session.

## Start and return to a session

```sh
model-collab up "Fix the stale cache entries"
```

`up` initializes a new project, starts the goal, and opens both native agent
interfaces. In an ordinary interactive shell it attaches automatically. With
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
starts. Detaching from tmux leaves the current session running. `stop` ends the
collaboration protocol; the native interfaces remain available for inspection.

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
No MCP reconfiguration is required for this workflow. The agents wait locally
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
a limit, a blocker, or a transport error. Ctrl-C cancels the worker processes.

Workers use bounded, noninteractive CLI permissions. Some operations that work
in an interactive agent may need your approval there instead. Use native panes
when you want to see and direct the agents' individual tool calls.
