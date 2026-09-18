# Existing interactive terminal: %AGENT%

Stay in this interactive Codex or Claude Code session. The user must be able to
see your edits, tool calls, messages, and results here and interrupt you normally.
Do not launch `model-collab worker`, `codex exec`, `claude -p`, or another agent.
Your equal peer is running in the other terminal pane.

Repository: %REPO%
Participant: %AGENT%

Read `%REPO%/.collab/CONTEXT.md` and the peer contract below. Also read
`%REPO%/.collab/RESEARCH.md` and `%REPO%/.collab/BRIEF.md` if present; these contain
the user's research question, evidence sources, and constraints. Use your existing
shell tools to execute the CLI. This works without adding MCP to an already-open
session. Every command must include the exact repository and your participant ID.
The following CLI steps replace the contract's MCP send/wait steps.

1. Read the shared task and filtered inbox:
   `%CLI% status --repo %QUOTED_REPO% --agent %AGENT%`
2. Do the actual thinking, reading, editing, and testing in this visible session.
   Summarize checkable evidence, not private chain-of-thought. Before editing:
   `%CLI% claim --repo %QUOTED_REPO% --agent %AGENT% --files path/to/file`
   Release your claims with `release` when finished.
3. Submit exactly one JSON contribution for the current round using
   `%CLI% post --repo %QUOTED_REPO% --agent %AGENT% --session SESSION_ID --json -`
   and pass a JSON object on stdin through a quoted heredoc. `SESSION_ID` is the
   `session.id` from the status you prepared this contribution against; a post
   for a replaced goal is rejected. Include a unique `clientMessageId` and the
   latest `contextVersion` from that status. Never interpolate model text into
   executable shell expressions. Use the schema in the contract.
4. Display a short plain-language summary of the message you sent. Then wait:
   `%CLI% await-turn --repo %QUOTED_REPO% --agent %AGENT% --timeout 300000`
   This waits locally without invoking another model. If your shell tool returns
   a running-process handle, wait for that process; do not start duplicate waits.
   Read its returned JSON, show what your peer contributed, and take your next
   turn. If it times out while still waiting, return control to the user rather
   than retrying forever. The user can say “continue collaboration” to resume.
5. To verify a file-backed candidate, use:
   `%CLI% verify --repo %QUOTED_REPO% --agent %AGENT% --candidate m1 --check NAME`
   Use a check name from status. Never accept a stale candidate or a failed check.
6. Stop on `paused`, `converged`, `blocked`, `exhausted`, or `stopped`. If the user
   interrupts, their newest instruction takes priority. To share a correction
   with both peers, use `%CLI% note --repo %QUOTED_REPO% "User correction"`.
   Notes invalidate old votes and checks; reread status and its contextVersion.
   On a user pause request, call `%CLI% pause --repo %QUOTED_REPO%` and return
   control. Resume only when the user requests it, using the `resume` command.

Never type into, close, or take over the other terminal pane. Exchange messages
only through this repository's collaboration files and CLI. The README mirrors
the conversation for the user. Do not read peer proposals through raw files while
the independent phase is still sealed. No new goal may be invented to evade a
stop condition. If no active goal exists, ask the user for one.

---

%PEER_CONTRACT%
