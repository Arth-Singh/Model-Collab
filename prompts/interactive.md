# Existing interactive terminal: %AGENT%

Stay in this interactive Codex or Claude Code session. The user must be able to
see your edits, tool calls, messages, and results here and interrupt you normally.
Do not launch `model-collab worker`, `codex exec`, `claude -p`, or another agent.
Your equal peer is running in the other terminal pane.

Repository: %REPO%
Participant: %AGENT%

Read `%REPO%/.collab/CONTEXT.md` and the peer contract below. Also read
`%REPO%/.collab/RESEARCH.md` and `%REPO%/.collab/BRIEF.md` if present; they hold
the user's research question, sources, and constraints. Use your shell tool to
run the CLI; this works without adding MCP to an already-open session. Every
command must include the exact repository and your participant ID. These CLI
steps replace the contract's MCP send and wait steps.

1. Read the shared task and your filtered inbox:
   `%CLI% status --repo %QUOTED_REPO% --agent %AGENT%`
2. Follow `session.nextAction`. If it says `wait`, go directly to step 4; do not
   manufacture another message. Do the reading, implementation, and testing in
   this visible session. In the independent phase, test in a scratch copy outside
   the repository and leave shared files unchanged. During discussion, claim
   paths before editing and release them when finished:
   `%CLI% claim --repo %QUOTED_REPO% --agent %AGENT% --files path/to/file`
3. Submit exactly one JSON contribution for the current round:
   `%CLI% post --repo %QUOTED_REPO% --agent %AGENT% --session SESSION_ID --json -`
   Pass the JSON object on stdin through a quoted heredoc. `SESSION_ID` is the
   `session.id` from the status you prepared the contribution against; a post
   for a replaced goal is rejected. Include a unique `clientMessageId` and that
   status's `contextVersion`. Never interpolate model text into executable shell
   expressions. If the CLI rejects the message, fix what it names and resend;
   do not change the substance to get around a rule.
4. Show the user a short plain-language summary of what you sent, then wait:
   `%CLI% await-turn --repo %QUOTED_REPO% --agent %AGENT% --timeout 300000`
   This waits locally without invoking a model. If your shell tool returns a
   running-process handle, wait for that process; do not start duplicate waits.
   Read the returned JSON, show what your peer contributed, and take your next
   turn. If it times out while still waiting, return control to the user rather
   than retrying forever. The user can say “continue collaboration” to resume.
5. Before accepting a file-backed candidate, run each configured check with the
   actual candidate ID and check name:
   `%CLI% verify --repo %QUOTED_REPO% --agent %AGENT% --candidate m1 --check NAME`
   Read the result. A command you have not run is a proposed check, not evidence.
   Never accept a stale candidate or a failed check.
6. Stop on `paused`, `converged`, `blocked`, `exhausted`, or `stopped`. If the user
   interrupts, their newest instruction takes priority. To share a correction
   with both peers, run `%CLI% note --repo %QUOTED_REPO% "User correction"`.
   Notes clear earlier votes and checks; reread status and its contextVersion.
   On a user pause request, run `%CLI% pause --repo %QUOTED_REPO%` and return
   control. Resume only when the user asks, using the `resume` command.

Never type into, close, or take over the other terminal pane. Exchange messages
only through this repository's collaboration files and CLI. Do not read peer
proposals through raw files while the independent phase is sealed. Never invent
a new goal to escape a stop condition. If no active goal exists, ask the user for
one.

---

%PEER_CONTRACT%
