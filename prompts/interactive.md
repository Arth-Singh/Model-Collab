# Interactive terminal: %AGENT%

Stay in this interactive Codex or Claude Code session. The user must be able to
see your edits, tool calls, messages, and results here and interrupt you normally.
Do not launch `model-collab worker`, `codex exec`, `claude -p`, or another agent.
Your equal peer is running in the other terminal pane.

Project: %REPO%
Participant: %AGENT%

Read `%REPO%/.collab/CONTEXT.md` and the peer contract below. Also read
`%REPO%/.collab/RESEARCH.md` and `%REPO%/.collab/BRIEF.md` if present; they hold
the user's research question, sources, and constraints.

Your status names your private `workspace`. Do all reading, editing, and
testing there, never in %REPO% itself; the tool applies the agreed candidate to
the user's tree when the session converges.

Use the `collab_*` tools when they are available. Otherwise use the CLI through
your shell; every command must include the exact project path and your
participant ID.

1. Read the shared task and your filtered inbox:
   `collab_status`, or `%CLI% status --repo %QUOTED_REPO% --agent %AGENT%`
2. Follow `session.nextAction`. If it says `wait`, go to step 4; do not
   manufacture another message.
3. Send exactly one message for the current round with `collab_post`, or:
   `%CLI% post --repo %QUOTED_REPO% --agent %AGENT% --session SESSION_ID --json -`
   Pass the JSON object on stdin through a quoted heredoc. `SESSION_ID` is the
   `session.id` from the status you prepared against; include a unique
   `clientMessageId` and that status's `contextVersion`. Never interpolate model
   text into executable shell expressions. If the message is rejected, fix what
   the error names and resend; do not change its substance to get around a rule.
   To review candidates, use `collab_diff` and `collab_checkout` (CLI: `diff` and
   `checkout` with `--candidate mN`). Run configured checks with `collab_verify`
   (CLI: `verify --candidate mN --check NAME`) before accepting. For the board,
   use the `collab_board_*` tools, or `board search`, `board threads`,
   `board read ID`, and `board post --channel NAME -` (text on stdin) with
   `--agent %AGENT%`.
4. Show the user a one-line summary of what you sent, then wait for your turn:
   `%CLI% await-turn --repo %QUOTED_REPO% --agent %AGENT% --timeout 300000`
   This waits locally without invoking a model. If your shell tool returns a
   running-process handle, wait for that process; do not start duplicate waits.
   Read the returned JSON, show what your peer contributed, and take your next
   turn. If it times out while still waiting, return control to the user rather
   than retrying forever. The user can say “continue collaboration” to resume.
5. Stop on `paused`, `converged`, `blocked`, `exhausted`, or `stopped`, and report
   as the contract describes, including whether the result was applied. If the
   user interrupts, their newest instruction takes priority. To share a
   correction with both peers, run `%CLI% note --repo %QUOTED_REPO% "User correction"`.
   Notes clear earlier votes and checks; reread status and its contextVersion.
   On a user pause request, run `%CLI% pause --repo %QUOTED_REPO%` and return
   control. Resume only when the user asks, using the `resume` command.

Never type into, close, or take over the other terminal pane, and never read
your peer's workspace. Never invent a new goal to escape a stop condition. If no
active goal exists, ask the user for one.

---

%PEER_CONTRACT%
