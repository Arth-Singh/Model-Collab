# Changelog

## 0.5.0 — 2026-10-30

The two-agent pair is replaced by a swarm. This is a breaking change: the
pair's commands, MCP tools, board, and tmux panes are gone.

- **A swarm of agents.** `model-collab up` starts a mixed team of headless
  Claude Code and Codex agents (9 of each by default; `--agents`, `--claude`,
  `--codex`). Nobody is assigned a role: agents claim pieces of the goal in a
  shared chat, build them in their own clones, and push to one shared `main`.
- **SwarmChat.** Agents talk over a local [SwarmChat](https://github.com/Pranjal2041/swarmchat)
  server with channels, direct messages, threads, and a browser viewer
  (`model-collab view`). Both agent sandboxes block localhost, so agents reach
  the chat through Model Collab's MCP server, with one token per agent.
- **Git as the integration point.** A bare origin starts at a snapshot of your
  project and refuses force pushes. Each agent's clone keeps its Git directory
  outside the sandboxed workspace, because Codex makes any `.git` inside a
  writable root read-only.
- **Fresh sessions.** The supervisor runs each agent in a loop of short
  sessions. An agent that has nothing to do waits without spending tokens and
  is woken when a message reaches it. Failed sessions back off; usage limits
  back off longer and are counted.
- **Ending a run.** A run finishes when every agent has waited for the quiet
  period and the configured checks pass on `main`; the result is then applied
  to your working tree. Failing checks are posted to the chat and wake the
  swarm. A run also ends at its deadline or with `model-collab stop`, and
  `model-collab apply` takes any run's result later.
- **No secrets for agents.** Agents get an allowlisted environment; API keys
  and tokens in your shell never reach them unless you pass them by name.
- **Project memory** now folds each run's chat, check results, and agent
  summaries into `.collab/MEMORY.md`.

## 0.4.0 — 2026-09-27

A redesign of the protocol around independent work and cross-examination.

- **Worktrees.** Each agent solves the goal in its own Git worktree from a
  snapshot of your project. Proposals stay sealed until both agents have
  proposed.
- **Cross-examination by running code.** Agents read each other's candidates
  with `collab_diff`, test them in clean copies from `collab_checkout`, and run
  configured checks with `collab_verify`.
- **Fewer messages.** A proposal counts as its author's vote, and one
  acceptance ends the session. The agreed candidate is applied to your working
  tree atomically, and never over files you changed in the meantime.
- **Judgment calls.** When no check can settle a disagreement, the less
  confident agent yields instead of blocking or conceding to pressure. A peer's
  report that the other agent cannot reproduce counts only as a claim.
- **Project board.** Agents and users post findings, dead ends, and decisions
  in threads that carry across goals, with search and paging.
- **Project memory.** After each goal, one tool-less model call condenses it
  into `.collab/MEMORY.md`, which the next goal reads.
- **Safer unattended workers.** Codex workers ignore your Codex config and
  execpolicy rules and have web search off. Claude Code workers run in its OS
  sandbox. A Codex turn whose model stream stalls is retried once.
- **Setup checks.** `model-collab doctor` checks Git, tmux, both CLIs, the
  flags workers need, and that you are in a repository.
- **Evaluation.** [docs/evaluation.md](docs/evaluation.md) reports results on
  hard programming exercises, and `eval/polyglot/` contains the harness.

## 0.2.0

Both agents worked in the same working tree: each investigated, shared a
proposal, and reviewed the other's until they agreed.
