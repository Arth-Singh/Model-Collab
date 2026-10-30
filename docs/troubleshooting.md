# Troubleshooting

Start with:

```sh
model-collab doctor
```

This checks Node.js, Git, SwarmChat, Codex, and Claude Code, the flags the
agents need, and that you are in a Git repository, without starting a model.
It does not test your sign-in or usage allowance. Sign in through each CLI
before starting a run.

## The command is not found

Run `npm link` from the Model Collab checkout. If it fails with `EACCES`, your
global npm directory belongs to root. Instead of using `sudo`, point npm at a
directory you own and add it to your PATH:

```sh
npm config set prefix ~/.npm-global
export PATH="$HOME/.npm-global/bin:$PATH"
npm link
```

If your shell still cannot find the command, run `npm prefix -g` and check that
its `bin` directory is on your PATH. You can also invoke the checkout directly:

```sh
node /path/to/Model-Collab/bin/model-collab.js doctor
```

## SwarmChat is missing

Install it as a user tool:

```sh
uv tool install swarmchat==0.1.0      # or: pipx install swarmchat==0.1.0
```

Make sure the directory it installs into, usually `~/.local/bin`, is on your
PATH. If `swarmchat` lives elsewhere, set its path in `chatCommand` in
`.collab/state.json`.

## Agents cannot reach the chat or the network

This is intended. Both CLIs' sandboxes block network access, including
localhost, so agents reach the chat only through the `chat_*` tools of their
MCP server, `model-collab serve`, which runs outside the sandbox. A command in
an agent's shell that needs the network, such as installing a package, fails.
Install dependencies in your working tree before the run; directories named in
`dependencyDirs` are linked into every clone.

On Linux, Claude Code's sandbox needs `bubblewrap` and `socat`. Install them
with your package manager, for example `sudo apt install bubblewrap socat`.

Tools that write caches under your home directory may fail inside the
sandbox. Point them at a directory in the project; Model Collab already does
this for Go.

## Agents hit usage limits

Every agent uses your own CLI sign-in, so a large swarm reaches subscription
limits quickly. A session that fails with a usage limit shows `rate_limited`
in the output and in `model-collab status`. The agent waits 60 seconds, then
twice as long after each further failure, up to 15 minutes. After 5 failures
in a row it retires; when every agent has retired, the run fails without
applying anything.

Run fewer agents (`--agents 4`), give one backend more of the swarm
(`--claude 6 --codex 2`), or use a lower `--effort`. The result of a failed run
can still be applied with `model-collab apply`.

## Agents duplicate each other's work

Some duplication is normal in the first minutes, while agents claim pieces.
Persistent duplication means the goal has fewer independent pieces than
agents. Run fewer agents, or describe the parts of the goal in the goal text or
`.collab/CONTEXT.md` so claims are easier. A `model-collab note` that assigns
an area to an agent by name also works.

## A run seems stuck

Read `model-collab status`. Agents in `waiting` make no model calls. They wake
for a direct message, an @mention, a post in another channel, or a post from
you or the supervisor; a plain post in `#general` wakes nobody. If every agent
is waiting but checks keep failing, the run ends after `maxCheckRounds`. Watch
the chat with `model-collab view` to see who is blocked on whom, and steer with
`model-collab note "..."`.

A Codex session that prints nothing for 10 minutes while no command runs has
lost its model stream, most often because the computer slept or the network
dropped. It is retried once, then counts as a failed session. Keep the
computer awake during a run: on macOS, run `caffeinate -i model-collab up ...`
and keep the lid open.

## The supervisor died

If the terminal running `up` was killed, the run stays marked as running.
`model-collab stop`, or the next `model-collab up`, notices that the
supervisor is gone. It stops the orphaned agent CLIs and the chat server, and
marks the run ended. Only processes that are still `claude` or `codex` under
the recorded process IDs are stopped.

The run's result is then the last commit on its origin's `main`, and
`model-collab apply` takes it as usual. It was not fetched into
`refs/model-collab/result`; to read its history before the next run replaces
`.collab/run`:

```sh
git fetch .collab/run/origin.git main:refs/model-collab/recovered
git log refs/model-collab/recovered
```

## A run ended before anything was applied

Only a `finished` run applies its result. Read `model-collab status` for the
reason:

- `expired`: the deadline passed. Raise `--minutes`, or apply the partial result.
- `stopped`: you stopped it.
- `failed`: checks still failed after `maxCheckRounds`, or every agent retired.

Review `git diff HEAD refs/model-collab/result` and run `model-collab apply` if
you want it.

## The result was not applied

You edited one of the files the result changes after the run started, or a
write failed. Nothing was written; a partial write is rolled back.
`model-collab status` names the file or the error. Commit, stash, or restore
your edits, then run `model-collab apply`.

## A check failed

A check runs in a fresh copy of the swarm's `main`, using its configured
argument array without a shell. Verify that the command works from a clean
checkout. Only the ignored directories named in `dependencyDirs` are linked
into the copy; see [dependency directories](configuration.md#dependency-directories).
Build output and tool caches are not.

## Changed settings did not take effect

`configure` is rejected while a run is in progress, and flags on `up` apply to
that run only. Use `model-collab configure --json` to see the saved settings.

## An agent CLI exits immediately

Run `model-collab doctor`. It names any flag your Codex or Claude Code version
lacks, such as `--ignore-rules` or `--add-dir`; update that CLI. Each session's
full output is saved under `.collab/run/logs/<agent>/`.

## Project memory was not updated

The run itself is unaffected. The message names the cause: usually the CLI was
unavailable or returned malformed memory. Retry with
`model-collab memory update`, or use Codex with `--agent codex`. If you edited
`MEMORY.md` while an update was running, the update left your version in place;
run it again.

## Reporting a problem

Do not edit `.collab/state.json` to repair a run.
[Open an issue](https://github.com/Arth-Singh/Model-Collab/issues) with the
command, the error message, the client versions, and a redacted
`model-collab transcript`.
