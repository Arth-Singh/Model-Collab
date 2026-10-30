# Configuration

Settings live in `.collab/state.json` and apply to every later run. Three
commands take the same setting flags:

| Command     | Effect                                                                     |
| ----------- | -------------------------------------------------------------------------- |
| `init`      | Creates `.collab/` with these settings. Fails if it already exists.        |
| `configure` | Changes saved settings. Without flags, prints them. Rejected during a run. |
| `up`        | Uses saved settings, with any flags given applying to this run only.       |

`up` creates `.collab/` with defaults if `init` was never run. `configure
--json` and `init --json` print the complete settings as JSON. The format is
described in [`schemas/config.schema.json`](../schemas/config.schema.json).

## Settings

| Setting               | Flag                          | Default                         | Range or form                        |
| --------------------- | ----------------------------- | ------------------------------- | ------------------------------------ |
| `claude`              | `--claude N`                  | 9                               | 0–32 Claude Code agents              |
| `codex`               | `--codex N`                   | 9                               | 0–32 Codex agents                    |
| (both)                | `--agents N`                  |                                 | Claude Code gets the odd one         |
| `models.claude`       | `--claude-model ID`           | `claude-opus-5-5`               | Any model your Claude Code accepts   |
| `models.codex`        | `--codex-model ID`            | `gpt-6-astra`                   | Any model your Codex accepts         |
| `effort`              | `--effort LEVEL`              | `high`                          | Passed to both CLIs                  |
| `deadlineMinutes`     | `--minutes N`                 | 60                              | 0.1–1440                             |
| `sessionMinutes`      | `--session-minutes N`         | 30                              | 0.1–240                              |
| `maxSessions`         | `--max-sessions N`            | 40                              | 1–500 sessions per agent             |
| `quietSeconds`        | `--quiet-seconds N`           | 30                              | 1–3600                               |
| `staggerSeconds`      | `--stagger-seconds N`         | 3                               | 0–120                                |
| `checks`              | `--checks JSON`               | none                            | See [checks](#checks)                |
| `checkTimeoutSeconds` | `--check-timeout N`           | 300                             | 1–3600                               |
| `maxCheckRounds`      | `--max-check-rounds N`        | 3                               | 1–10                                 |
| `dependencyDirs`      | `--dependency-dirs A,B`       | `node_modules`, `.venv`, `venv` | Up to 20 folder names                |
| `passEnv`             | `--pass-env A,B`              | none                            | Up to 50 variable names              |
| `tensorboard`         | `--tensorboard on\|off`       | on                              | on or off                            |
| `tensorboardDir`      | `--tensorboard-dir DIR`       | `.collab/tensorboard`           | Relative to the project, or absolute |
| `monitorSeconds`      | `--monitor-seconds N`         | 15                              | 1–600                                |
| `scoreCommand`        | `--score JSON`                | none                            | An argv array, like a check          |
| `scoreSeconds`        | `--score-seconds N`           | 120                             | 5–3600                               |
| `preset`              | `--preset NAME`               | `coding`                        | `coding` or `research`               |
| `memory`              | see [memory](#project-memory) | on                              | on or off                            |
| `chatCommand`         | (edit `state.json`)           | `swarmchat`                     | Command name or path                 |

A swarm needs at least one agent. Agents are named `claude-1`, `codex-1`,
`claude-2`, and so on, and start `staggerSeconds` apart in that order.

- **`deadlineMinutes`** ends the whole run. Sessions in progress are stopped and
  nothing is applied; `model-collab apply` can still take the result.
- **`sessionMinutes`** limits one agent session. The next session is told to
  check for unfinished work.
- **`maxSessions`** retires an agent after that many sessions in one run.
- **`quietSeconds`** is how long every agent must be waiting before the
  supervisor runs the checks and, if they pass, finishes the run.
- **`maxCheckRounds`** is how many times failing checks may send the swarm back
  to work before the run fails.
- **`tensorboardDir`** collects every run's TensorBoard scalars. Point several
  projects at one absolute folder to compare their runs side by side.
- **`scoreCommand`** runs on `main` in a clean checkout every `scoreSeconds` and
  once more on the final `main`. See [monitoring](usage.md#monitor-growth-with-tensorboard).

```sh
model-collab configure --agents 6 --minutes 90 --session-minutes 20
model-collab configure --claude 4 --codex 0 --claude-model claude-sonnet-5-5
model-collab up "Port the parser to the new AST" --agents 8 --effort xhigh
```

Use model IDs and effort levels your installed clients and account support.
Every agent uses its CLI's existing sign-in.

## Checks

Checks are named commands written as argument arrays:

```sh
model-collab init --checks '{"test":["python","-m","pytest","-q"]}'
```

Or load them from a file:

```json
{
  "test": ["npm", "test"],
  "types": ["npm", "run", "typecheck"]
}
```

```sh
model-collab configure --checks @checks.json
```

Names use lowercase letters, digits, dashes, and underscores. Each check runs
without a shell in a fresh copy of the swarm's `main`, with dependency links,
so shell operators such as `&&` are not interpreted; put complex checks in a
script, or run them through `sh -c`. Each run may take `checkTimeoutSeconds`.
The run record keeps the last 2,000 characters of its output.

Checks decide when a run is done. Without them, a run finishes as soon as every
agent has waited for the quiet period. Agents can run any check themselves with
the `swarm_check` tool.

## Dependency directories

Each agent's clone contains only files Git tracks or could track. Installed
dependencies are usually ignored, so the clones and check copies link to them
instead. By default any ignored directory named `node_modules`, `.venv`, or
`venv` is linked, at any depth. Links are excluded from the agents' commits.
Build output such as Rust's `target/` is not linked, so agents never build
into the same directory.

```sh
model-collab configure --dependency-dirs node_modules,.venv,vendor
```

An empty list (`--dependency-dirs ''`) links nothing. Linked directories are
shared with your working tree, not copied: an agent that installs a package
into one changes it for every agent and for you.

## The agents' environment

Agent processes get an allowlist of environment variables: `PATH`, `HOME`,
`USER`, `LOGNAME`, `SHELL`, `TERM`, `TMPDIR`, `TZ`, `LANG`, `LC_*`, `XDG_*`,
`COLORTERM`, `NO_COLOR`, the CLIs' own `CODEX_HOME` and `CLAUDE_CONFIG_DIR`,
certificate and proxy settings, and common toolchain variables (Go, Rust,
Java, pyenv, virtualenv, conda, nvm, pnpm, Bun, Deno, Homebrew, and C
compilers). API keys, tokens, and cloud credentials in your shell are left out.
Go's build cache points at `.gocache` inside each clone.

If a build needs another variable, pass it by name:

```sh
model-collab configure --pass-env CARGO_NET_OFFLINE,MY_TOOL_HOME
```

Pass a secret only if the work requires it. Every agent sees what you pass, and
a swarm shares what one agent finds.

## Presets

`coding` is the default. `research` adds the
[research contract](../prompts/research.md) to every session: precise claims,
checked sources, observations separate from interpretation, and bounded
experiments. `init` or `configure` with this preset also creates
`.collab/RESEARCH.md`, a brief every agent reads; fill it in.

## Project memory

Memory is on by default. After each run, `up` makes one model call at low
effort to update `.collab/MEMORY.md`, which every agent reads in later runs.

```sh
model-collab memory show              # print the memory
model-collab memory update            # remember finished runs now
model-collab memory update --agent codex --effort medium
model-collab memory clear             # delete it; run history and the chat stay
model-collab configure --memory off   # stop updating and using it
```

Start a project without it with `model-collab init --no-memory`. Skip it for
one run with `up --no-memory`. You can edit `MEMORY.md` yourself; the next
update keeps your edits.

## Command reference

| Command                          | Use                                                    |
| -------------------------------- | ------------------------------------------------------ |
| `doctor`                         | Check installed tools without starting a model         |
| `init`                           | Create `.collab/` and settings without starting a run  |
| `configure`                      | Inspect or change settings for later runs              |
| `up "goal"`                      | Start a run and supervise it until it ends             |
| `view`                           | Watch every chat in your browser                       |
| `status`                         | Show the latest run                                    |
| `note "instruction"`             | Post to `#general` as you; wakes every waiting agent   |
| `stop [reason]`                  | End the run without applying                           |
| `apply`                          | Apply the latest run's result to your working tree     |
| `transcript`                     | Print every message of the latest run                  |
| `tensorboard`                    | Open TensorBoard on every run's scalars                |
| `memory show`, `update`, `clear` | Read, refresh, or delete the project memory            |
| `serve --agent ID`               | One agent's MCP server; agent CLIs start it themselves |

All project commands accept `--repo /path/to/project`. `up`, `init`,
`configure`, `status`, `transcript`, `doctor`, and `memory update` accept
`--json`. `up --json` prints one JSON event per line and the final run record.
Run any command with `--help` for its options.
