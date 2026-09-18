# Configuration

## Models

| Client      | Default model          | Default effort |
| ----------- | ---------------------- | -------------- |
| Codex       | `gpt-6-astra`          | `xhigh`        |
| Claude Code | `claude-fable-5-1[1m]` | `xhigh`        |

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
| Discussion rounds | 4          |
| Contributions     | 24         |
| Conversation time | 30 minutes |

The independent proposal phase precedes discussion rounds. Each peer gets one
contribution per round. The first limit reached ends the conversation without
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

The agents must run all configured checks before accepting a proposal. Checks
run in the project directory without a shell, so shell operators such as `&&`
are not interpreted. Put complex checks in a script and invoke that script.

## Command reference

| Command                    | Use                                                |
| -------------------------- | -------------------------------------------------- |
| `doctor`                   | Check installed tools without invoking models      |
| `configure`                | Inspect or update settings for future goals        |
| `up "goal"`                | Initialize and start both agents                   |
| `attach`                   | Rejoin the project's native terminal session       |
| `status --human`           | Read a session summary                             |
| `pause`, `resume`, `stop`  | Control the current collaboration                  |
| `note "instruction"`       | Send a shared user correction                      |
| `init`                     | Prepare context and settings before starting       |
| `start "goal"`             | Start the protocol with agents you launch yourself |
| `launch --agent codex`     | Open one native interface in this pane             |
| `worker --agent codex`     | Run one unattended peer                            |
| `export --format markdown` | Export the conversation                            |

All project commands accept `--repo /path/to/project`. Run any command with
`--help` for its options.

`up --print` previews setup without changing files or invoking models.
`up --json` emits structured startup information; worker mode emits structured
events as well. `status` without `--human` preserves the JSON interface used by
agents. `doctor --json` and `attach --print` support automation.
Project setup and control commands (`init`, `start`, `configure`, `pause`,
`note`, `resume`, and `stop`) also accept `--json`.

Advanced integration commands (`serve`, `config`, `post`, `claim`, `release`,
`verify`, `wait`, `await-turn`, and `refresh`) are covered in the
[protocol reference](protocol.md).
