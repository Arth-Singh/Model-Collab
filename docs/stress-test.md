# Stress test: how many agents one machine can run

On October 31, 2026, we ran the swarm at 1, 4, 8, and 18 agents on one
MacBook (Apple M5 Pro, 15 cores, 48 GB) with the default models and Claude
Code and Codex subscriptions. The question was whether the machine and the
subscriptions can carry 18 agents, and how the swarm behaves at that size. It
was not an accuracy evaluation: every setup solved the task. A fifth run gave
18 agents a single function, to see how a large swarm handles too little
work.

## Setup

- **Task.** A fresh repository holding only a specification of 24 small,
  independent Python functions (`chunk`, `roman_to_int`, `levenshtein`,
  `merge_intervals`, and so on), each to go in its own module with unit tests.
  The goal told the agents to divide the functions among themselves.
- **Grading.** A hidden test file the agents never saw, with 24 cases, one per
  function, run on the run's final commit.
- **Runs.** `model-collab up` at commit `d6ac4b9` (the 1-agent run at
  `2d096e9`, which only adds cache excludes and one prompt sentence), with
  `claude-opus-5-5` and `gpt-6-astra` at high effort, half Claude Code and
  half Codex, a 15-minute deadline, 10-minute sessions, a 30-second quiet
  period, 3 seconds between agent starts, and one configured check
  (`python3 -m unittest discover -s tests -q`). One run per size.
- **Machine.** Load average, free memory, and the number and memory of
  `claude` and `codex` processes, sampled every 15 seconds.

## Results

| Agents          | Wall time | Hidden tests | Commits | Sessions | Tokens | Claude Code cost | Messages | Peak agent processes | Peak agent memory |
| --------------- | --------- | ------------ | ------- | -------- | ------ | ---------------- | -------- | -------------------- | ----------------- |
| 1 (Claude Code) | 2.4 min   | 24/24        | 1       | 1        | 0.30M  | $0.54            | 4        | 9                    | 3.0 GB            |
| 4 (2 + 2)       | 4.5 min   | 24/24        | 9       | 7        | 2.05M  | $1.54            | 23       | 14                   | 3.6 GB            |
| 8 (4 + 4)       | 2.6 min   | 24/24        | 9       | 8        | 2.89M  | $1.71            | 28       | 20                   | 4.5 GB            |
| 18 (9 + 9)      | 2.6 min   | 24/24        | 19      | 19       | 4.54M  | $3.05            | 45       | 30                   | 5.5 GB            |

Wall time runs from the goal's post to the end of the run, including the
30-second quiet period and the final check. Tokens are input plus output as
the CLIs report them, about 90% of input from cache. Cost is what Claude Code
reports for its own agents; Codex does not report cost. On a subscription it
is usage, not a bill. No session failed, hit a usage limit, or was retried, and
no agent retired, at any size.

## What it shows

- **The machine and the subscriptions carried 18 agents.** Load average stayed
  under 7 and free memory above 85% at every size. 18 agents peaked at 30
  agent CLI processes and 5.5 GB. Neither CLI reported a usage limit. A longer
  run at 18 agents will reach subscription limits sooner, because usage scales
  with the number of agents.
- **Coordination held at 18.** In every run one agent proposed a split by
  specification number within 10 seconds, every other agent claimed its share
  in one line, and no two agents built the same function. Commits rebased onto
  each other without a lost change.
- **On this task the swarm was not faster than one agent, and cost far more.**
  One Claude Code agent wrote all 24 functions and their tests in one 2.4-minute
  session with 0.30M tokens. Eight and eighteen agents took 2.6 minutes with
  10 and 15 times the tokens. Going from 8 to 18 agents added 57% more tokens
  and no speed. Each agent pays a fixed cost to read the specification, the
  chat, and the contract, and a run pays for staggered starts and the quiet
  period. A task that one agent finishes in minutes leaves nothing for a swarm
  to win.
- **Small swarms reviewed each other's work.** With 4 agents, cross-review
  found two defects the hidden tests did not cover, and both were fixed before
  the run ended: `flatten` overflowed the recursion limit at 1,500 nesting
  levels, and `rle_decode` accepted non-ASCII digits. A reviewer also flagged
  that `format_bytes(1048575)` prints `1024.0 KiB`, an edge the specification
  leaves open. The 18-agent run ended before anyone reviewed.
- **A large swarm degrades gracefully on a task too small to split, but still
  pays for every agent.** Asked for one function only, 18 agents finished in
  1.9 minutes with one commit, correct, and nobody built a second copy.
  claude-1 claimed the function and pushed it within 20 seconds. Six Codex
  agents each claimed a read-only review (an exhaustive grammar comparison,
  numeric boundaries, test coverage, scope, performance) and posted the
  result; the other Claude Code agents read the chat and waited. Each of the 18
  agents still ran one session: 1.77M tokens and $1.59 of Claude Code usage,
  several times what one agent needs for this.
- **Two problems repeated, now fixed.** Agents committed `__pycache__` early,
  and every later rebase hit binary conflicts until an agent untracked it;
  clones now exclude tool caches. At the end of the 8-agent run five agents
  each ran and reported the same passing check; the contract now tells them
  not to repeat a check a teammate already reported.

## What it does not show

One run per size on one easy task cannot say whether a swarm helps on real
work. The published evidence says a swarm mainly buys wall-clock time on long
tasks, where parallel work outweighs the fixed cost per agent (see
[design](design.md)). Testing that needs tasks that take a single agent hours,
with a single agent given the same wall-clock time and the same tokens as
baselines, and the same swarm without chat as a control.
