# Changelog

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
