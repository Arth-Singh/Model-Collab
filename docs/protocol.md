# Protocol reference

Model Collab coordinates local agents through a project-local state store. Native
sessions use MCP tools or CLI commands; both interfaces share the same protocol.
See [design](design.md) for why the protocol works this way.

## Session lifecycle

Starting a goal records a snapshot of the project, including uncommitted and
untracked files, as a Git commit under `refs/model-collab/base`. Each peer gets a
detached Git worktree of that snapshot at `.collab/work/<agent>`. Ignored
directories named in the `dependencyDirs` setting (by default `node_modules`,
`.venv`, and `venv`, at any depth) are linked into each worktree so tests can
run. Other ignored files, including build output and caches such as
`__pycache__`, are not linked, so one agent's build cannot overwrite another's.
Linked directories are shared with your working tree; an agent that installs
packages into one changes it for everyone.

1. **Solve.** Each peer changes files in its own worktree and submits one
   `proposal`. Status withholds other peers' messages and candidates until every
   peer has proposed.
2. **Cross-examine.** All candidates become visible and discussion rounds begin.
   Each peer sends at most one message per round.
3. **Finish.** The session converges when every participant's vote points at the
   same current candidate, no challenge against it is open, and every configured
   check has passed on it. The agreed candidate is then applied to the user's
   working tree.

A proposal is its author's vote. With two peers, one `accept` of the other's
candidate is enough to converge, so the shortest session is one proposal each
and one acceptance.

Terminal states are `converged`, `blocked`, `exhausted`, and `stopped`. A limit
or blocker ends the conversation without declaring a winner. Starting another
goal archives the previous conversation under `.collab/history/` and replaces
the worktrees.

## Candidates

A `proposal` snapshots every file its author changed relative to the base:
modified, added, and deleted files, including untracked files that are not
ignored. Contents are copied to `.collab/candidates/<id>/files`, so a candidate
never changes after it is proposed. Linked dependency directories and `.collab`
are never captured. A proposal with no file changes must include a written
`solution`.

A new proposal supersedes its author's previous candidate and removes every vote
for it. Other votes are kept.

Review tools work on candidates, not worktrees:

| Tool              | CLI        | Result                                                   |
| ----------------- | ---------- | -------------------------------------------------------- |
| `collab_diff`     | `diff`     | Unified diff of the candidate against the base           |
| `collab_checkout` | `checkout` | A runnable copy at `.collab/review/<agent>/<id>`         |
| `collab_verify`   | `verify`   | Runs a configured check in a fresh copy, then removes it |

During the solve phase a peer can review only its own candidates.

## Messages

```json
{
  "clientMessageId": "codex-proposal-001",
  "contextVersion": 0,
  "kind": "proposal",
  "summary": "Expire an entry at its exact expiry timestamp.",
  "evidence": ["test/cache.test.js: 7 cases from the spec pass, including now == expiresAt."],
  "solution": "Use now >= expiresAt in get() and size(); size() prunes before counting."
}
```

Allowed kinds are `proposal`, `challenge`, `evidence`, `accept`, and `blocked`.
`candidate` names an existing candidate; `repliesTo` names a message; `resolves`
lists challenges authored by this peer. Only proposals carry `solution`. Every
message except `blocked` needs evidence. See the
[JSON schema](../schemas/message.schema.json).

An `accept` is rejected while a challenge against that candidate is open, unless
the same message resolves the sender's own challenges, and until every
configured check has passed on it. Only a challenge's author can resolve it.

Use a fresh `clientMessageId` for each contribution. Reusing it with identical
content is retry-safe; reusing it with different content is rejected. A message
that repeats one of the sender's earlier messages is rejected.

```sh
model-collab status --agent codex
# Use session.id from the state you prepared this contribution against.
model-collab post --agent codex --session SESSION_ID --json @proposal.json
```

`--json -` reads the message from standard input. When using shell tools, pass
message text through a quoted heredoc or a file instead of interpolating it into
a command. The MCP equivalent includes `sessionId` alongside the message fields.

## Checks and applying

Checks are user-configured argument arrays. Each run uses a fresh copy of the
base plus the candidate's changes, without a shell, with the project's check
timeout (300 seconds by default). A check cannot alter the candidate it verifies.
Passing checks cover only what their commands test.

On convergence the tool writes the candidate's changes into the user's working
tree. It first compares every affected path with the base, including file
contents, the executable bit, symlink targets, and parent directories. If the
user changed any of them in the meantime, nothing is written and the session
records the conflict; resolve it and run `model-collab apply`. Applying is all
or nothing: if a write fails partway, the files already written are restored
and the working tree is left as it was. Every attempt is recorded in the
session's `applyLog`. After a session ends, `apply --candidate mN` applies any
candidate, for example one of two unresolved alternatives.

## Waiting and human intervention

`await-turn` waits locally until a peer has an actionable update or the session
pauses or ends. It can wait for up to five minutes without a model call.
`wait` is the shorter revision-based primitive used by MCP clients.

Pause rejects new protocol actions. It cannot interrupt a native edit already in
progress. A shared note clears votes and checks made against earlier
instructions; peers must acknowledge the new `contextVersion`. Resume extends
the deadline by the time spent paused.

## Storage and integration

`.collab/state.json` is canonical. Updates use an interprocess lock and atomic
replacement. `.collab/README.md` and `.collab/messages.jsonl` are generated views;
`refresh` rebuilds them after an interrupted write. Sessions from the earlier
shared-tree protocol are stopped when this version first reads them.

```sh
model-collab serve --agent codex
model-collab config --agent codex
```

`serve` runs the stdio MCP server with a fixed peer identity. `config` prints its
connection configuration without changing global client settings. Native
`launch` supplies this configuration automatically.

The MCP tools are `collab_status`, `collab_start`, `collab_post`, `collab_wait`,
`collab_diff`, `collab_checkout`, `collab_verify`, and `collab_stop`. Worker
connections expose only status, review, and verification tools; the worker posts
each turn's message itself.

This is a coordination protocol for a trusted local project. An identity bound
to an MCP connection is not an authentication boundary against processes that can
edit the state file, and worktree isolation is a working arrangement, not a
security boundary. The user remains responsible for the repository and the
commands configured as checks.
