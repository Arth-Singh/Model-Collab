# How a run works

`model-collab up` starts a run and supervises it in the foreground until it
ends. This page describes each step, the agents' tools, and where everything is
stored. See [design](design.md) for why it works this way.

## Starting

1. **Snapshot.** The project's working tree, including uncommitted and
   untracked files, is recorded as a Git commit under `refs/model-collab/base`.
   Your index and working tree are not touched.
2. **Origin.** A bare repository, `.collab/run/origin.git`, starts with `main`
   at that snapshot. It borrows your repository's objects through Git
   alternates instead of copying them, so it stores only the swarm's commits.
   It sets `receive.denyNonFastForwards` and `receive.denyDeletes`: nobody can
   force-push or delete `main`.
3. **Clones.** Each agent gets a clone at `.collab/run/work/<agent>`. Its Git
   directory lives outside the workspace, at `.collab/run/git/<agent>`
   (`git clone --separate-git-dir`), because Codex's sandbox makes any `.git`
   inside a writable root read-only. Commits carry the agent's name. The clone
   pulls with rebase, and your global Git hooks and commit signing are off.
   Ignored directories named in `dependencyDirs` (by default `node_modules`,
   `.venv`, and `venv`) are linked from your working tree and excluded from
   commits. If you started from a subdirectory, each agent works in the same
   subdirectory of its clone.
4. **Chat.** A SwarmChat server starts on a free localhost port. Its data
   folder, `.collab/chat`, keeps every chat across runs. Every agent, `user`
   (you), and `model-collab` (the supervisor) get a chat account with a new
   token for this run. All of them are members of `#general`. Messages from
   earlier runs are marked read, so agents start with this goal.
5. **Goal.** `user` posts the goal, success criteria, team, and deadline to
   `#general`.
6. **Agents.** Agents are named by backend and number: `claude-1`, `codex-1`,
   `claude-2`, and so on, alternating. They start `staggerSeconds` apart in that
   order.

## Agent sessions

Each agent runs in a loop of sessions. A session is one headless process:
`claude -p` or `codex exec`, in the agent's clone. Its prompt is the
[swarm contract](../prompts/swarm.md) (plus the
[research contract](../prompts/research.md) for the `research` preset), the
facts of the run, the agent's summary from its previous session, and the shared
context files `.collab/CONTEXT.md`, `.collab/RESEARCH.md`, and
`.collab/MEMORY.md`.

A session ends when the agent returns JSON:

```json
{ "next": "continue", "summary": "Lexer pushed in 4f2a91c; next: error messages." }
```

- `continue` starts a fresh session right away.
- `wait` puts the agent to sleep. Waiting makes no model calls. The agent is
  woken by a message newer than the start of its last session that is one of
  these:
  - a direct message to it;
  - a post in a channel other than `#general`;
  - a post that @mentions its ID, or contains `@all`;
  - a post from `user` or `model-collab`, such as your notes and failing
    checks.

  A plain status post in `#general` wakes nobody, so agents @mention whoever
  must act on it. Without this rule, every "done" post started a session in
  every waiting agent only to read it. The supervisor waits with SwarmChat's
  `wait --peek --where`, so the message stays unread for the agent.

A session that reaches `sessionMinutes` is stopped, and the next session is
told to check `git status` for unfinished work. A Codex session that prints
nothing for 10 minutes while no command runs has lost its model stream; it is
retried once with a note, then counts as failed.

**Failures.** A session that fails waits before the next attempt: 10 seconds
after an error, 60 seconds after a usage limit (`rate_limited`), doubling with
each failure in a row up to 15 minutes. After 5 failures in a row the agent
retires. An agent also retires after `maxSessions` sessions.

**Sandboxes.** Codex runs with `--sandbox workspace-write`, ignores your Codex
config and execpolicy rules, and has web search off. Claude Code has only its
file tools and Bash, and runs every shell command in its OS sandbox. Both can
write only their clone, their Git directory, and the origin, and neither has
network access. Both get an allowlisted environment; see
[configuration](configuration.md#the-agents-environment).

## Agent tools

Both sandboxes block localhost, so agents cannot reach the chat server
themselves. Each agent's CLI starts `model-collab serve --agent <id>`, an MCP
server that runs outside the sandbox and calls SwarmChat with that agent's
token.

| Tool           | Result                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chat_read`    | Unread messages across all chats, oldest first, then marked read. Narrow by chat, `last` N, search text, sender, or a whole thread.              |
| `chat_send`    | Sends to `#general`, another channel, one agent (a direct message), or several agents separated by commas. `replyTo` keeps a thread together.    |
| `chat_wait`    | Blocks up to 300 seconds until a new message arrives, then returns it.                                                                           |
| `chat_chats`   | The agent's chats with unread counts and members.                                                                                                |
| `chat_channel` | Creates a channel with members, joins a public channel, adds members, or lists public channels.                                                  |
| `swarm_status` | The goal, the agent's workspace, time left, unread count, each teammate's state, recent commits on `main`, configured checks, and check results. |
| `swarm_check`  | Runs one configured check on the current `main` in a clean checkout.                                                                             |

Messages name their chat: `#general`, `#parser`, or the members of a direct
chat such as `claude-1,codex-1`. A message holds up to 8,000 characters.

## Ending

The supervisor checks the run every second. A run ends in one of these
statuses:

| Status     | When                                                                                                               | Applied? |
| ---------- | ------------------------------------------------------------------------------------------------------------------ | -------- |
| `finished` | Every agent that has not retired has been waiting for `quietSeconds`, and every configured check passes on `main`. | Yes      |
| `failed`   | Checks still fail after `maxCheckRounds` rounds, every agent retired, or the supervisor itself failed.             | No       |
| `expired`  | The deadline passed.                                                                                               | No       |
| `stopped`  | You ran `model-collab stop` or pressed Ctrl-C.                                                                     | No       |

When the swarm goes quiet, each check runs without a shell in a fresh copy of
`main` with dependency links, under `checkTimeoutSeconds`. If one fails,
`model-collab` posts its name, exit status, and the end of its output to
`#general`. That message wakes every waiting agent. With no checks configured,
a quiet swarm finishes at once.

At the end, sessions in progress are stopped, `model-collab` posts the outcome
to `#general`, and the chat server stops last. The server runs in its own
process group, so Ctrl-C reaches only the supervisor, which shuts down in this
order.

## The result

The swarm's `main` is fetched into your repository as
`refs/model-collab/result`, so its history stays available after the next run
replaces `.collab/run`:

```sh
git log refs/model-collab/result
git diff HEAD refs/model-collab/result
```

A `finished` run applies the difference between the snapshot and the final
`main` to your working tree. Applying is all or nothing. It first compares
every affected path with the snapshot, including file contents, the executable
bit, symlink targets, and parent directories. If you changed any of them during
the run, nothing is written and the run records the conflict. If a write fails
partway, the files already written are restored. Submodule changes are
refused, and a result may change at most 500 files, 10 MiB per file, 50 MiB in
total. `model-collab apply` applies the latest run's result whatever its status.

## Project memory

`.collab/MEMORY.md` summarizes earlier runs in at most 10,000 bytes, under the
headings User preferences, Project knowledge, Pitfalls, and Goal history. Every
agent reads it with the shared context.

After a run, `up` makes one model call without tools (Claude Code at low
effort, or Codex if the swarm had no Claude agent). The call reads the current
memory and the run's record: goal and criteria, status and reason, commits and
what was applied, the team with session counts and retirements, your notes,
check results, each agent's last summary, and every chat message of the run.
It returns the complete new memory, or the same memory when nothing durable was
learned. The tool then:

1. redacts common secret formats,
2. rejects output that lacks the headings in order or exceeds the size limit,
3. keeps the file unchanged if you edited it during the call, leaving the run to
   the next update, and
4. records the run in `.collab/memory.json` so it is remembered only once.

If you edited `MEMORY.md` since the last update, the call receives a diff of
your edits and must keep them. An update handles at most three runs; older
ones are marked skipped. Records from the earlier two-agent protocol are left
out. A failed update is reported and never fails the run.

## Storage

| Path                               | Contents                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `.collab/state.json`               | Settings and the latest run. Written under a lock with atomic replacement. |
| `.collab/README.md`                | A generated summary of the latest run.                                     |
| `.collab/CONTEXT.md`               | Your shared context for every agent.                                       |
| `.collab/MEMORY.md`, `memory.json` | Project memory and its bookkeeping.                                        |
| `.collab/chat/`                    | SwarmChat's data: plain JSONL logs per chat, users, and read positions.    |
| `.collab/run/origin.git`           | The shared origin.                                                         |
| `.collab/run/work/`, `run/git/`    | Each agent's clone and its Git directory.                                  |
| `.collab/run/logs/<agent>/`        | Each session's process output, including token usage.                      |
| `.collab/run/tokens.json`          | This run's chat tokens, readable only by you.                              |
| `.collab/run/result/`              | The files of the result while it is applied.                               |
| `.collab/history/<run>.json`       | The record of an earlier run.                                              |
| `.collab/history/<run>/`           | Its origin and session logs. Clones and tokens are deleted when archived.  |

A run is archived when the next one starts.

The supervisor records the process ID of each running session. If the
supervisor died during a run, for example because its terminal was killed, the
next `up` or `stop` stops the orphaned agent CLIs and the stale chat server.
It stops an agent's whole process group, and only while that process ID still
belongs to `claude` or `codex`. The run is then marked `failed` (or `stopped`,
for `stop`) and archived when the next run starts.

## Trust boundary

This is a coordination tool for a trusted local project. Agents can read most
files on your machine, including `.collab/run/tokens.json` and SwarmChat's
data folder, whose own documentation notes that any process running as your
user can read it. They cannot use a token, because their sandboxes block
localhost; only the MCP server, which fixes each agent's identity, reaches the
chat. Sandboxing belongs to Codex and Claude Code, and the clones are a working
arrangement, not a security boundary. You remain responsible for the
repository, the commands configured as checks, and any environment variable
you pass to agents.
