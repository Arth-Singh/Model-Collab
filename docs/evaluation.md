# Evaluation

Does a pair do better than one agent? We measured it on programming exercises
graded by tests the agents never see.

On 20 hard exercises, the pair solved 85% of tasks: far more than Codex alone
(62%) and fewer than Claude Code alone (92%), at about three times Claude's cost
and six times its time. On 21 exercises that one agent already solves, the pair
broke nothing. The pair's gains come from Claude catching Codex's mistakes. Its
losses come from disagreements no test could settle, where the rule it uses to
decide sometimes picks the wrong reading.

## Setup

- **Tasks.** Exercism exercises in Python, Go, and Rust from the
  [Aider polyglot benchmark](https://github.com/Aider-AI/polyglot-benchmark)
  (commit `7e0611e`). Each agent sees the instructions and a stub. Grading runs
  the exercise's own unit tests, which are removed from the workspace before
  the agents start.
- **Hard set (20 tasks).** Chosen before any pair was run, from the exercises
  Claude Haiku 4.5 failed while passing at least one test: the 17 that Claude
  Sonnet 5 at medium effort also failed, plus the 3 Sonnet passed on which Haiku
  passed the fewest tests. The rule is in
  [`selection.json`](../eval/polyglot/selection.json).
- **Held-out set (21 tasks).** The other exercises from the same screen. Sonnet
  passed all of them, so they test whether the pair breaks what one agent gets
  right. They were chosen after the hard-set runs and never used to change the
  protocol.
- **Conditions.** Codex `gpt-6-astra` alone; Claude Code `claude-opus-5-5`
  alone; and the pair, `model-collab up --ui workers` with the same two models.
  All run at high effort with no network in the sandboxes, and Codex has web
  search off. Claude Code's web tools were removed only after one pair run used
  them (see the last change below); every Claude call behind the current
  results was checked, and none used the web. Every condition gets the same
  prompt: the task, and that a hidden test suite will grade the files.
- **Repeats.** Neither CLI exposes a sampling seed, so the hard set ran as
  three independent trials per condition. Tables report the mean and the sample
  standard deviation across trials. Paired tests pool the 60 (task, trial)
  pairs and use an exact McNemar test.

The harness, task lists, and screens are in
[`eval/polyglot`](../eval/polyglot/README.md).

## Results on the hard set

The pair ran at commit `4d45a87`. Pass rates are over 20 tasks per trial.

| Condition                    | Pass rate, mean ± SD | Per trial   | Claude cost per task | Minutes per task |
| ---------------------------- | -------------------- | ----------- | -------------------- | ---------------- |
| Codex alone                  | 61.7% ± 2.9          | 65, 60, 60  | not reported         | 1.3              |
| Claude Code alone            | 91.7% ± 2.9          | 90, 95, 90  | $0.23                | 0.6              |
| Pair                         | 85.0% ± 5.0          | 90, 85, 80  | $0.76                | 3.8              |
| Better of the two solo tries | 95.0% ± 5.0          | 100, 95, 90 | —                    | —                |

Paired over the 60 (task, trial) pairs:

- **Against Codex alone**, the pair passed 17 tasks Codex failed and failed 3
  Codex passed (exact McNemar p = 0.0026).
- **Against Claude Code alone**, the pair passed none that Claude failed and
  failed 4 that Claude passed (p = 0.125).

All 60 sessions converged. They averaged 1.2 rounds of cross-examination, 4.1
messages, and 2.2 model calls per agent; 13 ended on the shortest path of two
proposals and one acceptance.

## Held-out set

One trial, same commit and settings.

| Condition         | Passed | Claude cost per task | Minutes per task |
| ----------------- | ------ | -------------------- | ---------------- |
| Codex alone       | 20/21  | not reported         | 1.4              |
| Claude Code alone | 21/21  | $0.23                | 0.6              |
| Pair              | 21/21  | $0.66                | 3.3              |

The pair lost nothing Claude solved alone and fixed Codex's only failure, a Go
exercise whose code did not compile. All 21 sessions converged, in 1.05 rounds
on average. Across both sets, the applied candidate was Claude's in 56 of 81
sessions and Codex's in 25.

## Where the pair loses

All four losses against Claude alone came from judgment calls: disagreements
that no test either agent could run would settle.

- **go-forth, two trials.** The instructions define a number as "a sequence of
  one or more (ASCII) digits", so `-1` is a word. The hidden tests push negative
  numbers. Codex cited the sentence, and the contract's first rule, that
  explicit project text decides, made Claude yield. Claude alone passed two of
  three trials. On the Rust version of the same exercise, Claude alone read the
  sentence the same way and failed all three trials, so the pair lost nothing
  there.
- **rust-scale-generator, two trials.** Whether a chromatic scale lists the
  tonic again at the end: 13 notes or 12. No text settles it. Claude stated
  confidence 70 in 13, which is correct; Codex stated 80 or 90 in 12, citing
  instructions that describe how many pitches a scale has rather than how many
  notes the function returns. By the rule, the less confident reading yields.
  Claude alone passed all three trials.

Stated confidence is not calibrated. Codex, which solves 62% of these tasks
alone, stated the higher confidence both times. Before this rule, a fixed order
decided judgment calls and cost four tasks too (below); the rule changed which
tasks the pair lost, not how many.

## Changes made because of these runs

The protocol was changed after reading the pair's failures on the hard set.
Each change is in the git history with the case that prompted it. The first
full measurement, at commit `b8862e7`, before the confidence rule:

| Condition     | Pass rate, mean ± SD | Per trial  | Claude cost per task | Minutes per task |
| ------------- | -------------------- | ---------- | -------------------- | ---------------- |
| Pair, b8862e7 | 85.0% ± 5.0          | 90, 80, 85 | $0.77                | 3.7              |

It also lost four tasks to Claude alone and won none: go-forth twice, to a
literal reading of an example, and python-dot-dsl and python-tree-building once
each. One of its passes, rust-scale-generator in the first trial, came from a
Claude worker that read the exercise's upstream tests with WebFetch; see the
last row below.

| Problem seen                                                                                                                                                                                                                       | Change                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| The developer's Codex execpolicy rules let a worker run `curl` outside the sandbox. It fetched an upstream document for a newer version of the exercise, and the peer that had the right answer gave it up. The run was discarded. | Workers pass `--ignore-rules`.                                                                            |
| A peer withdrew a correct challenge on a report it could not reproduce.                                                                                                                                                            | A report the other agent cannot reproduce counts only as a claim.                                         |
| Two peers stuck on an ambiguous convention stopped the session, and nothing was applied.                                                                                                                                           | Judgment calls are settled instead of blocked.                                                            |
| A fixed order for judgment calls made the stronger agent yield to a literal reading of an example, three times on one task.                                                                                                        | Judgment calls are settled by stated confidence, following [ReConcile](https://arxiv.org/abs/2309.13007). |
| Codex's event log passed 1 MB and the worker killed the turn.                                                                                                                                                                      | Codex workers keep the last megabyte of the log instead.                                                  |
| A laptop that slept mid-run left agents waiting on dead connections until their turns timed out.                                                                                                                                   | A silent Codex turn is retried once; the harness reruns any job the computer slept through.               |
| A Claude worker fetched an exercise's upstream tests with WebFetch, which the developer's own Claude settings allowed for github.com. The run was discarded and rerun.                                                             | Claude workers and the solo Claude arm have only file tools and Bash.                                     |

## Caveats

- **Little headroom.** The hard set was chosen with weaker models. Claude Opus
  5.5 at high effort already solves 92% of it, and choosing the better of the
  two solo answers would reach 95%. A pair cannot show a large gain here.
- **Conventions dominate.** Most Codex failures come from unstated Exercism
  conventions, such as exact error messages or which notes a scale lists.
  Claude seems to know them better. A benchmark of unfamiliar code would test
  different things.
- **Tuned on the hard set.** Three protocol changes above, the rule for
  unreproducible reports and both judgment-call rules, were made after reading
  failures on these tasks. The held-out set is the check on whether they
  generalize.
- **Solo runs came first.** The solo trials ran about 13 hours before the pair
  trials, against the same model names. A model update in between would not
  show in the results.
- **Reruns.** Jobs that the computer slept through were discarded and run again
  from scratch. One pair job, rust-forth in the third trial, was discarded
  because its Claude worker used WebFetch, and was rerun at commit `4eb78af`,
  whose worker differs from `4d45a87` only by removing web tools and a stale
  file reference. No recorded result is an infrastructure failure. A web fetch
  shows up as a second model in a Claude call's usage, which is how the check
  above found it.
- **Solo Codex settings.** The solo Codex trials ran before workers passed
  `--ignore-rules`. None of their logs contains a command that the developer's
  execpolicy rules would have let out of the sandbox.
- **Personal instructions.** Both CLIs loaded the developer's global
  `CLAUDE.md`, `AGENTS.md`, and Codex skills in every condition. This is a
  shared confound.
- **Codex cost.** The Codex CLI does not report cost, so cost figures cover
  Claude only.
