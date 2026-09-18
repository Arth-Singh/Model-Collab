# Model Collab

Codex and Claude Code solve a shared coding goal as equal peers. Each develops an
independent proposal, exchanges short, structured evidence, challenges specific
claims, and explicitly accepts a concrete solution. A bounded protocol prevents
endless back-and-forth. It works in two iTerm2 panes or any terminal.

This is a local first release. It does not assume that agreement improves
correctness; the evaluation harness measures that separately.

## One-command research collaboration

Install this package once, then use it from any research or coding repository:

```sh
git clone https://github.com/Arth-Singh/Model-Collab.git
cd Model-Collab
npm ci
npm link

cd /path/to/your/rl-project
model-collab up "Investigate whether truncation handling biases our GAE estimates" \
  --preset research
```

`up` initializes project-local context, starts the shared goal, and opens both
full native agent interfaces in a new tmux session. Each receives its initial
instruction automatically. Both agents work in the selected repository and stay
visible and interruptible. No prompt copy/paste is needed for this workflow.
It requires `tmux`, `codex`, and `claude` on PATH and existing CLI authentication.
It works inside iTerm2 or another terminal; it creates new tmux panes rather than
typing into your existing conversations.

Run from a normal interactive shell to attach automatically. When invoked by an
agent's shell tool or with `--detach`, it prints the attach command. You can ask an
agent: **“Run `model-collab up` in this repository with the goal: investigate our
PPO instability. Use the research preset.”** Attach to the printed session to
watch and intervene. Repeating `up` with the same live goal reuses its terminal
session; it does not launch duplicate peers. A different live goal must be stopped
explicitly first.

Useful options:

```sh
# Inspect setup without starting models or changing files.
model-collab up "Study our reward shaping" --repo /path/to/project --print

# Start a coding project with configured verification.
model-collab up "Fix rollout bootstrapping" --preset coding \
  --checks '{"test":["python","-m","pytest","-q"]}'

# Optional unattended mode without native TUIs.
model-collab up "Review our experiment plan" --ui workers
```

Existing configuration and user-written context are preserved. `--minutes`,
`--max-rounds`, `--max-messages`, and `--checks` configure new projects; existing
projects keep their recorded limits and checks. `--preset` defaults to research
for new projects and the recorded preset for existing ones. A paused session is
not resumed unless `--resume` is supplied.

In tmux, `Ctrl-b o` switches peer panes; `Ctrl-b n` switches between the peers and
the control window. The control window accepts `status`, `pause`, `note <text>`,
`resume`, and `stop`. `Ctrl-b d` detaches while the session remains available.
Use the native agent interface to interrupt an ongoing model turn. Protocol
deadlines reject late contributions but do not forcibly terminate native TUIs.

The research preset adds [research-specific instructions](prompts/research.md)
and a `.collab/RESEARCH.md` brief covering hypotheses, sources, baselines,
experimental budgets, metrics, and uncertainty. Agents must distinguish evidence
from conjecture, preserve unresolved objections, and propose falsifiable next
experiments. The coding and research presets share the same bounded peer protocol.

## Install

Requires Node.js 22.12+, npm, and authenticated `codex` and `claude` CLIs.

```sh
git clone https://github.com/Arth-Singh/Model-Collab.git
cd Model-Collab
npm ci
npm test
npm link
```

The npm package is not published yet. `npm link` installs the `model-collab`
command from your local checkout. You can instead run `node /absolute/path/to/Model-Collab/bin/model-collab.js`.

## Start in any coding repository

```sh
cd /path/to/your/project
model-collab init --checks '{"test":["npm","test"]}'
model-collab start "Fix the stale cache bug" \
  --criteria "Reproduce the failure" "Pass the existing tests" "Review the final patch"
```

Omit `--checks` for a discussion-only session. Add shared architecture and
constraints to `.collab/CONTEXT.md`. Existing `AGENTS.md`, `CLAUDE.md`, global
settings, and model permissions remain under your control. Initialization adds
`.collab/` to `.gitignore` and writes local prompts and state.

### Keep your existing Codex and Claude Code panes

Initialization writes `.collab/START-CODEX.md` and `.collab/START-CLAUDE.md`.
Paste this into the existing Claude Code prompt, using your real absolute path:

```text
Read /path/to/your/project/.collab/START-CLAUDE.md and follow it in this visible session. Work on the active shared goal. Do not launch background workers.
```

Paste the corresponding instruction into the existing Codex prompt:

```text
Read /path/to/your/project/.collab/START-CODEX.md and follow it in this visible session. Work on the active shared goal. Do not launch background workers.
```

Both agents stay in their normal interactive interfaces. They use existing shell
tools to read filtered state, send JSON messages, claim files, and run checks.
Their actual work remains visible and interruptible. No MCP restart is needed.
Each agent prints what it sent and what its peer contributed.

After contributing, an agent runs `model-collab await-turn` through its shell
tool. This local wait returns when that peer can act, the session pauses/stops,
or a five-minute timeout expires. It avoids model polling while the command is
running. If an agent returns to its idle prompt after a timeout or interruption,
say **“continue collaboration”**. An idle native prompt cannot be awakened by a
README alone; this implementation does not inject keystrokes into your panes.

### Start fresh interactive panes

From a shell in each pane, run:

```sh
model-collab launch --repo /path/to/your/project --agent claude
# Run this in the other pane:
model-collab launch --repo /path/to/your/project --agent codex
```

These launch the full Claude Code and Codex interfaces, supply the same startup
instructions, and attach the collaboration MCP tools. Existing client permissions
are preserved. Defaults are `gpt-6-astra` and `claude-fable-5-1[1m]`, both at
`xhigh`; override with `--model` and `--effort`. Availability depends on the
installed clients and account. The first peer to speak has no extra authority.

### Intervene manually

Interrupt the current agent turn using its normal UI, then tell it to pause
collaboration. You can also run these from a separate shell:

```sh
model-collab pause --repo /path/to/your/project
model-collab note --repo /path/to/your/project "Keep the public API unchanged."
model-collab resume --repo /path/to/your/project
```

Pause rejects new contributions, claims, and verification results. It releases
claims and freezes the protocol deadline. It is cooperative: it cannot forcibly
stop an already-running native edit; interrupt that turn in its pane. A shared
note reaches both peers, clears old votes/checks, and increments `contextVersion`.
A contribution based on old user context is rejected. After resuming, tell any
idle agent to continue collaboration. You can stop permanently with `stop`.

### Optional automatic workers

`model-collab worker --agent codex` and `--agent claude` run unattended CLI turns
and print the conversation. This is an optional batch mode; it does not drive
an already-open interactive agent. It wakes automatically without model calls
while waiting and makes one invocation per scheduled contribution. Failures are
surfaced without automatic retry loops. Ctrl-C kills its native process group.

Workers use Codex's workspace-write sandbox and Claude file-edit permission mode,
with unapproved permission prompts denied. They expose status, claims, release,
and configured checks through MCP, without enabling permission bypass.

All modes share `.collab/README.md`, a live human transcript, and strict JSON in
`.collab/state.json` and `.collab/messages.jsonl`. The user can inspect either
pane or the shared transcript throughout the conversation.

## What the protocol enforces

| Rule | Behavior |
| --- | --- |
| Equal peers | Same tools and limits for each participant; no leader role |
| Independent start | Peer proposals hidden through the API until all initial contributions arrive |
| Bounded discussion | One contribution per peer per round; default 4 discussion rounds, 24 messages, 20 minutes |
| Evidence | Every non-blocker needs a concrete justification, test, reference, or counterexample |
| Explicit agreement | Every participant must accept the same candidate ID |
| Objections | An open challenge prevents accepting its candidate; only its author can close it |
| Fresh artifacts | Proposals snapshot file SHA-256 hashes; changed files require a new proposal |
| Verification | All configured checks must pass before acceptance; checks execute as argv without a shell |
| File coordination | Renewable advisory leases reject overlapping claims, including symlink aliases |
| Durable writes | Interprocess lock, atomic state replacement, retry-safe message IDs |
| Honest termination | `converged`, `blocked`, `exhausted`, or `stopped`; exhaustion never masquerades as agreement |

The independent phase is round 0. Discussion begins at round 1 after every peer
has proposed. A new proposal supersedes that author's previous candidate and
clears votes. A challenge also clears votes. Acceptance is an explicit durable
commitment; it remains valid until withdrawn by a non-accepting contribution or
cleared by a proposal or challenge. A peer may accept another peer's candidate.

Verification requires a file-backed proposal; include all relevant source and
test files. Checks cannot certify a text-only idea against unrelated repository
code. Include test results in the next contribution so the other peer can review
them, and revise the proposal if any declared artifact changes.

Claims are cooperative coordination, not filesystem locks. Agents can still
edit files outside the protocol. For competing implementations, use separate
worktrees and bring the selected patch into the shared repository before
publishing its final file snapshot. File hashes cover only declared artifacts;
list all files relevant to your proposed change. Passing configured checks does
not certify untested behavior. A converged record is historical; subsequent
repository edits do not retroactively update it.

The storage layer is for a trusted local repository and cooperating agents.
The server binds an identity per connection but is not an authentication boundary
against processes that can directly edit `.collab/state.json`. Shared peers can
read the underlying files, so independent-start sealing is a protocol guard,
not a secrecy boundary. Configure checks only from commands you trust.

## JSON messages and tools

```json
{
  "clientMessageId": "claude-initial-001",
  "kind": "proposal",
  "summary": "Expire entries when now is greater than or equal to expiresAt.",
  "evidence": ["At exactly expiresAt, the contract says the entry is unavailable."],
  "solution": "Use now >= expiresAt; prune before checking capacity.",
  "files": ["src/cache.js"]
}
```

`kind` is `proposal`, `challenge`, `evidence`, `accept`, or `blocked`.
`candidate` identifies a proposal, such as `m1`; `repliesTo` identifies a message;
`resolves` lists your own objections to close. Only proposals carry `solution`
and `files`. Server-issued IDs, timestamps, rounds, and fingerprints are not
client inputs. See [the message schema](schemas/message.schema.json) and
[the peer contract](prompts/peer.md).

Every contribution also names the session it was prepared against, taken from
`session.id` in the status the peer read. MCP `collab_post` takes it as an extra
`sessionId` field beside the message; the CLI takes the same value outside the
JSON as `post --session SESSION_ID`. It is not stored in the message. A post
whose session ID no longer matches the active goal is rejected, so a delayed
contribution cannot land in a replacement goal.

MCP exposes `collab_status`, `collab_start`, `collab_post`, `collab_wait`,
`collab_claim`, `collab_release`, `collab_verify`, and `collab_stop`.
The CLI provides the same workflow for agents with shell tools:

```sh
model-collab status --agent codex
# SESSION_ID is session.id from the status output above
model-collab post --agent codex --session SESSION_ID --json @proposal.json
model-collab claim --agent codex --files src/cache.js
model-collab verify --agent codex --candidate m1 --check test
model-collab export --format markdown > discussion.md
model-collab export --format jsonl > discussion.jsonl
model-collab stop --reason "Need a missing dependency from the user"
```

`.collab/state.json` is the canonical versioned JSON record. README and JSONL
views update automatically after writes; agents never race to append to the same
README. A crash between canonical state and view updates can leave a derived
view stale; `model-collab refresh` regenerates it. Starting a
new session archives the previous terminal session under `.collab/history/`.
Initialization refuses to overwrite an existing configuration.

## Evaluate the hypothesis

```sh
# Preview a 16-call RL pilot without invoking either model.
model-collab eval --suite rl --tasks rl-gae-boundaries --calls 4 \
  --max-calls 16 --minutes 30 --timeout 90000 --plan

# Execute that bounded pilot and save its manifest, logs, report, and post draft.
model-collab eval --suite rl --tasks rl-gae-boundaries --calls 4 \
  --max-calls 16 --minutes 30 --timeout 90000 --output eval-results

# Plan a larger study: 6 tasks × 4 conditions × 5 trials × 4 calls = 480 calls.
# This command only plans; remove --plan only when that budget is authorized.
model-collab eval --suite rl --trials 5 --calls 4 --max-calls 480 \
  --minutes 240 --timeout 90000 --plan
```

The harness compares `solo-codex`, `solo-claude`, `independent-pair`, and
`collaboration`. Each gets
the same total CLI invocation budget. Solo agents use their extra calls for
self-review. Collaborating agents first solve independently, then see their
peer's proposals and revise. The independent pair has the same model mixture,
concurrency, and preselected final submitter, without exchanging proposals.
Private tests grade the final submission; their
answers and pass/fail feedback are never included in model prompts.

Reports include final test performance, wall time, call count, provider-reported
token usage where available, failures, and raw artifacts. A manifest with source
hashes and the fixed schedule is written before the first call. Each call is
journaled durably. Incomplete runs are separated from graded wrong answers, and
paired uncertainty resamples distinct tasks. Equal invocation count
does not guarantee equal tokens, cost, reasoning effort, or internal API calls.
The evaluation discussion is a controlled batch experiment, separate from the
interactive MCP round state machine.

The `rl` suite covers six verifiable RL math and implementation tasks; `coding`
retains the three initial programming tasks. Six task families remain a small
study, even with many trials or hidden cases. A pilot establishes infrastructure
and task difficulty; it cannot establish general research superiority. See the
[research evaluation plan](docs/RESEARCH-EVALUATION.md) for units, baselines,
uncertainty, and requirements for a larger research study.

Generated code is executed with time limits in a separate local process. The
JavaScript VM is not a security sandbox for hostile code. Run evaluations in an
isolated container when evaluating untrusted providers or task sets.

## Development and references

See the [real conversation demo](examples/live-dialogue.md), [verified coding demo](examples/live-coding.md), [RL pilot results](eval/RL-PILOT.md), and [earlier evaluation failures](eval/RESULTS.md). The recorded demos used automatic CLI workers; native iTerm pane automation was not exercised. The RL pilot completed all 16 invocations, with all four conditions passing 27/27 cases on one task. It establishes no accuracy advantage for collaboration. A [local post draft](docs/research-post.md) describes that result without a general research claim.

```sh
npm ci
npm run check
npm test
npm pack --dry-run
```

The core protocol uses Node.js, Zod validation, `proper-lockfile`, and the
official MCP TypeScript SDK. Tests cover protocol behavior and an actual stdio
MCP connection; model-backed evaluations are opt-in.

- [Codex MCP documentation](https://developers.openai.com/codex/mcp)
- [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp)
- [Claude Code programmatic usage](https://code.claude.com/docs/en/headless)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x)

MIT licensed.
