# Protocol reference

Model Collab coordinates local agents through a project-local state store. Native
sessions use CLI commands or MCP tools; both interfaces share the same protocol.

## Conversation lifecycle

Each peer first proposes independently. The filtered API withholds the other
proposal until all peers have contributed. Discussion then advances in rounds,
with at most one contribution from each peer in a round.

The prompts keep shared source and test files unchanged during the independent
phase, so one peer's edits do not reveal its proposed fix to the other. Peers then
claim paths and implement during discussion. This is a cooperation rule; the
filesystem does not enforce it.

A proposal describes a concrete solution. A challenge names an objection to a
proposal; only its author can close that objection. Evidence messages add a
check, counterexample, or answer. Each peer must explicitly accept the same
candidate before the session can converge.

A replacement proposal or challenge clears previous votes. User corrections
increment the context version and invalidate decisions based on older context.
Contributions also carry the session ID they were prepared against, so delayed
work cannot be submitted to a replacement goal.

Terminal states are `converged`, `blocked`, `exhausted`, and `stopped`. A limit or
blocker ends the conversation without declaring a winner.

## Messages

```json
{
  "clientMessageId": "codex-proposal-001",
  "contextVersion": 0,
  "kind": "proposal",
  "summary": "Expire an entry at its exact expiry timestamp.",
  "evidence": ["The boundary case now == expiresAt must return a cache miss."],
  "solution": "Use now >= expiresAt when checking expiry.",
  "files": ["src/cache.js", "test/cache.test.js"]
}
```

Allowed kinds are `proposal`, `challenge`, `evidence`, `accept`, and `blocked`.
`candidate` names an existing proposal; `repliesTo` names a message; `resolves`
lists objections authored by this peer. Only proposals carry solution text and
file snapshots. See the [JSON schema](../schemas/message.schema.json).

Use a fresh `clientMessageId` for each contribution. Reusing it with identical
content is retry-safe; reusing it with different content is rejected.

```sh
model-collab status --agent codex
# Use session.id from the state you prepared this contribution against.
model-collab post --agent codex --session SESSION_ID --json @proposal.json
```

`--json -` reads the message from standard input. When using shell tools, pass
message text through a quoted heredoc or a file instead of interpolating it into
a command. The MCP equivalent includes `sessionId` alongside the message fields.

## Files and checks

Agents claim exact paths before editing:

```sh
model-collab claim --agent codex --files src/cache.js test/cache.test.js
model-collab release --agent codex
```

Claims are renewable advisory leases. Overlapping paths and symlink aliases are
rejected, but the protocol cannot prevent an agent from editing a file directly.
Use separate worktrees for competing implementations.

Proposals record hashes of declared files. A changed artifact requires a new
proposal. All configured checks must pass before acceptance:

```sh
model-collab verify --agent codex --candidate m1 --check test
```

Checks execute as argument arrays without a shell. File hashes cover declared
artifacts only, and checks cover the behavior their commands actually test.

## Waiting and human intervention

`await-turn` waits locally until a peer has an actionable update or the session
pauses or ends. It can wait for up to five minutes without a model call.
`wait` is the shorter revision-based primitive used by MCP clients.

Pause rejects new protocol actions and releases claims. It cannot interrupt an
already-running native edit. A shared note invalidates votes and checks made
against earlier instructions. Resume extends the protocol deadline by the time
spent paused.

The interactive [peer instructions](../prompts/interactive.md) describe the
complete send, wait, and resume loop. The [peer contract](../prompts/peer.md)
defines how agents should justify decisions and resolve disagreements.

## Storage and integration

`.collab/state.json` is canonical. Updates use an interprocess lock and atomic
replacement. `.collab/README.md` and `.collab/messages.jsonl` are generated views;
`refresh` rebuilds them after an interrupted write. Starting another goal archives
the previous conversation under `.collab/history/`.

```sh
model-collab serve --agent codex
model-collab config --agent codex
```

`serve` runs the stdio MCP server with a fixed peer identity. `config` prints its
connection configuration without changing global client settings. Native
`launch` supplies this configuration automatically.

The MCP tools are `collab_status`, `collab_start`, `collab_post`, `collab_wait`,
`collab_claim`, `collab_release`, `collab_verify`, and `collab_stop`. Worker
connections expose only the tools needed for one bounded contribution.

This is a coordination protocol for a trusted local project. An identity bound
to an MCP connection is not an authentication boundary against processes that can
edit the state file. Independent proposal filtering is likewise a protocol rule,
not filesystem secrecy. The user remains responsible for the repository and the
commands configured as checks.
