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

## Board

The project board keeps findings across goals in `.collab/board.jsonl`.
`.collab/BOARD.md` is a generated view of it. A channel holds threads; a thread
is its first post plus flat replies. Post IDs look like `p12`, and a thread's ID
is its first post's ID.

| Tool                       | CLI                               | Result                                                  |
| -------------------------- | --------------------------------- | ------------------------------------------------------- |
| `collab_board_post`        | `board post --channel`/`--thread` | Starts a thread in a channel, or replies to a thread    |
| `collab_board_search`      | `board search [query]`            | Posts and replies, newest first                         |
| `collab_board_threads`     | `board threads`                   | Threads by latest activity (or `--sort created`)        |
| `collab_board_read_thread` | `board read ID`                   | A thread's first post and replies, oldest first         |
| `collab_board_read_post`   | `board read ID`                   | A post's full text, sliced by Unicode character offsets |

- **Destinations.** A post names exactly one of `channel` (creating it if
  needed) or `thread`. Replies go to a thread's first post; there are no nested
  replies. Channel names use 1–48 lowercase letters, digits, dots, dashes, or
  underscores.
- **Search.** Every whitespace-separated query term must appear in the post,
  ignoring case. Filters for channel, author, and `after` (a post ID) combine.
  There is no ranking; results are newest first.
- **Pages.** Lists return up to 20 results by default and 50 at most, with
  previews of 1,000 characters by default. A page stops early rather than exceed
  20,000 characters; continue with `nextCursor`.
- **Visibility.** While a goal is in its independent phase, a peer's posts from
  that goal are hidden from the other peer, like its candidate. Posts from
  earlier goals and posts by the user are always visible. The user sees
  everything.
- **Status.** `board` in status lists channels, the five most active threads,
  and `newForYou`: up to ten posts by others in this goal since the viewer's
  last discussion message, with 150-character previews.
- **Limits.** A post holds up to 8,000 characters. Each peer may post twelve
  times per goal; the user has no limit. Peers cannot post while the session is
  paused. Posts are not protocol messages: they do not change the session,
  count as votes, or wake a waiting peer.
- **Retries.** An optional `requestId` makes a post retry-safe: repeating it
  with the same content returns the original post, and with different content is
  rejected. Posting the same text to the same place twice is rejected.

The user posts as `user` with `model-collab board post`. Unlike a note, a board
post does not clear votes or change `contextVersion`.

## Project memory

`.collab/MEMORY.md` summarizes earlier goals in at most 10,000 bytes, under the
headings User preferences, Project knowledge, Pitfalls, and Goal history. Workers
receive it with the shared context; interactive agents are told to read it.

When a goal ends, one model call without tools reads the current memory and the
goal's record: its goal and success criteria, outcome and applied change, user
notes, messages with evidence, checks, and the board posts made during it. It
returns the complete new memory, or the same memory when nothing durable was
learned. The tool then:

1. redacts common secret formats,
2. rejects output that lacks the headings in order or exceeds the size limit,
3. keeps the file unchanged if the user edited it during the call, leaving the
   goal to the next update, and
4. records the goal in `.collab/memory.json` so it is remembered only once.

If the user edited `MEMORY.md` since the last update, the call receives a diff of
those edits and must keep them. An update handles at most three goals; older
unremembered goals are marked skipped.

`up --ui workers` updates memory when the session ends. Other sessions are
remembered by the next `up`, before the new goal starts, or by
`model-collab memory update`. A failed update is reported and never blocks a
goal.

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

`.collab/state.json` is canonical for the session; `.collab/board.jsonl` for
the board. Updates use an interprocess lock and atomic
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
`collab_diff`, `collab_checkout`, `collab_verify`, `collab_stop`, and the five
`collab_board_*` tools. Worker connections expose status, review, verification,
and board tools; the worker posts each turn's message itself.

This is a coordination protocol for a trusted local project. An identity bound
to an MCP connection is not an authentication boundary against processes that can
edit the state file, and worktree isolation is a working arrangement, not a
security boundary. The user remains responsible for the repository and the
commands configured as checks.
