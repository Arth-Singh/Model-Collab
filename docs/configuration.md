# Configuration

## Models

| Client      | Default model     | Default effort |
| ----------- | ----------------- | -------------- |
| Codex       | `gpt-6-astra`     | `high`         |
| Claude Code | `claude-opus-5-5` | `high`         |

Use model IDs and effort levels supported by your installed clients and account.
Both agents use their existing CLI authentication.

```sh
model-collab up "Review the parser" \
  --codex-model YOUR_CODEX_MODEL \
  --claude-model YOUR_CLAUDE_MODEL \
  --effort high
```

For `launch` and `worker`, use `--model` to select that agent's model. Native
launches preserve normal client permissions and add project-local collaboration
tools. Overrides apply to newly launched processes; repeating `up` on a live
session reuses its existing agents.

## Presets and limits

`coding` is the default for new projects. `research` adds source-checking and
experiment-planning instructions, plus `.collab/RESEARCH.md`.

| Setting           | Default    |
| ----------------- | ---------- |
| Preset            | coding     |
| Discussion rounds | 3          |
| Contributions     | 24         |
| Conversation time | 30 minutes |
| Check timeout     | 300 s      |
| Worker turn limit | 900 s      |

The independent proposal phase precedes discussion rounds. Each peer gets one
contribution per round. With two agents, one acceptance of the other's proposal
ends the session, so most agreeable sessions finish in the first discussion
round. The first limit reached ends the conversation without
inventing agreement. Native interfaces remain open; protocol limits do not kill
an agent that is already working.

Set limits when initializing the project:

```sh
model-collab up "Investigate the memory leak" \
  --minutes 45 --max-rounds 6 --max-messages 20
```

Existing projects retain their saved configuration. Passing new limits to `up`
does not replace it. To change limits, preset, or checks, stop the current session
and use `configure`:

```sh
model-collab stop
model-collab configure --minutes 45 --max-rounds 6
model-collab up "Investigate the next issue"
```

Run `configure` without options to inspect the saved settings. Changes are rejected
while a session is active or paused. Existing conversation history is preserved.

## Verification commands

Checks are named commands expressed as argument arrays:

```sh
model-collab init --checks '{"test":["python","-m","pytest","-q"]}'
model-collab up "Fix the failing tests"
```

Or load a JSON file:

```json
{
  "test": ["npm", "test"],
  "types": ["npm", "run", "typecheck"]
}
```

```sh
model-collab init --checks @checks.json
```

The agents must run all configured checks before accepting a proposal. Each
check runs without a shell in a fresh copy of the project with the candidate's
changes, so shell operators such as `&&` are not interpreted. Put complex checks
in a script and invoke that script. Linked dependency directories (see below)
are available in that copy.

Each check run may take up to 300 seconds, bounded by the session deadline. Set
`--check-timeout SECONDS` (at most 3600) with `init`, `up` for a new project, or
`configure`. Long output does not fail a check; the saved result keeps the last
12,000 characters of each stream.

## Dependency directories

Each agent works in its own Git worktree, which contains only files Git tracks
or could track. Installed dependencies are usually ignored, so the worktrees and
check copies link to them instead. By default any ignored directory named
`node_modules`, `.venv`, or `venv` is linked, at any depth. Build output such as
Rust's `target/` is not linked, so the agents never build into the same
directory.

To link other ignored directories, list their names:

```sh
model-collab configure --dependency-dirs node_modules,.venv,vendor
```

An empty list (`--dependency-dirs ''`) links nothing. Linked directories are
shared with your working tree, not copied.

## Project memory

Memory is on by default. After each goal, one Claude call at low effort updates
`.collab/MEMORY.md`, which the agents read at the start of the next goal.

```sh
model-collab memory show              # print the memory
model-collab memory update            # remember finished goals now
model-collab memory update --agent codex --effort medium
model-collab memory clear             # delete it; history and the board stay
model-collab configure --memory off   # stop updating and using it
```

Start a project without it with `model-collab init --no-memory` or
`up --no-memory`. You can edit `MEMORY.md` yourself; the next update keeps your
edits.

## Command reference

| Command                        | Use                                                |
| ------------------------------ | -------------------------------------------------- |
| `doctor`                       | Check installed tools without invoking models      |
| `configure`                    | Inspect or update settings for future goals        |
| `up "goal"`                    | Initialize and start both agents                   |
| `attach`                       | Rejoin the project's native terminal session       |
| `status --human`               | Read a session summary                             |
| `diff --candidate mN`          | Show a candidate's changes                         |
| `apply`                        | Apply the agreed candidate (or `--candidate mN`)   |
| `pause`, `resume`, `stop`      | Control the current collaboration                  |
| `note "instruction"`           | Send a shared user correction                      |
| `board search`, `board post`   | Search or add to the project board                 |
| `board threads`, `board read`  | List threads or read a thread or post              |
| `memory show`, `memory update` | Read or refresh the project memory                 |
| `memory clear`                 | Delete the memory; history and the board stay      |
| `init`                         | Prepare context and settings before starting       |
| `start "goal"`                 | Start the protocol with agents you launch yourself |
| `launch --agent codex`         | Open one native interface in this pane             |
| `worker --agent codex`         | Run one unattended peer                            |
| `export --format markdown`     | Export the conversation                            |

All project commands accept `--repo /path/to/project`. Run any command with
`--help` for its options.

`up --print` previews setup without changing files or invoking models.
`up --json` emits structured startup information; worker mode emits structured
events as well. `status` without `--human` preserves the JSON interface used by
agents. `doctor --json` and `attach --print` support automation.
Project setup and control commands (`init`, `start`, `configure`, `pause`,
`note`, `resume`, and `stop`) also accept `--json`.

Advanced integration commands (`serve`, `config`, `post`, `checkout`,
`verify`, `wait`, `await-turn`, and `refresh`) are covered in the
[protocol reference](protocol.md).
