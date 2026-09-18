# Troubleshooting

Start with:

```sh
model-collab doctor
```

This checks Node.js, tmux, Codex, and Claude Code without invoking either model.
It does not test your model allowance or authentication. Sign in through each
native CLI before starting a session.

## The command is not found

Run `npm link` from the Model Collab checkout. If your shell still cannot find
the command, run `npm prefix -g` and check that its `bin` directory is on your
PATH. You can also invoke the checkout directly:

```sh
node /path/to/Model-Collab/bin/model-collab.js doctor
```

If `doctor` reports a missing native CLI, install that tool and sign in before
retrying. If tmux is missing, install it through your system's package manager.
Unattended worker mode (`up --ui workers`) does not require tmux.

## No panes appeared

When an agent runs `up` through a shell tool, there is no interactive terminal to
attach. Open an ordinary shell in your project and run:

```sh
model-collab attach
```

Inside an existing tmux session, `attach` prints the direct command so you can
open it from a separate terminal. The workflow creates its own tmux session;
it does not type into conversations already open in iTerm2.

## A model is unavailable

Check that the same model works in its native client. Account access and client
support determine which IDs and effort levels you can use. Supply supported
values with `up --codex-model`, `--claude-model`, and `--effort` when starting a
new pair of processes.

A native client may also show its own sign-in, trust, or permission prompt.
Resolve that prompt in its pane so the agent can begin.

## One agent stopped responding

Read `model-collab status --human` and inspect both native panes. An agent may be
waiting for its peer, asking for permission, or back at its prompt after a local
wait ended. Tell an idle agent to "continue collaboration".

If an agent process exited, open a separate terminal pane in the project and run
`model-collab launch --agent codex` or `--agent claude`. This joins the current
goal. Avoid starting a second instance while the original agent is still working.

If the entire tmux session closed, run `up` again with the current goal to recreate
the terminal. If the protocol already reached a limit, start a new goal instead.

## A different goal is already active

Finish or stop the existing goal before starting another:

```sh
model-collab status --human
model-collab stop
model-collab up "Your next goal"
```

A paused session also remains the current goal. Resume it explicitly or stop it.

## Changed limits did not take effect

`up` preserves an initialized project's settings. Stop the current session and
update them with `configure`:

```sh
model-collab stop
model-collab configure --minutes 45 --max-rounds 6
```

The next goal will use those settings. Use `configure --json` to inspect the
complete saved configuration.

## A check failed or a proposal became stale

A check runs in the project directory using its configured argument array. Verify
that command works there and that its dependencies are installed.

Proposals record the files under review. If those files change, the agent must
submit a new proposal and run checks again. This keeps agreement tied to the
version that was actually reviewed.

## The transcript looks out of date

Regenerate the readable transcript from saved state:

```sh
model-collab refresh
```

Do not edit `.collab/state.json` to repair a conversation. Keep the original state
and [open an issue](https://github.com/Arth-Singh/Model-Collab/issues) with the
command, error message, client versions, and relevant redacted transcript.
