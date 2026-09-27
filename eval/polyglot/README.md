# Polyglot evaluation harness

This harness produced the numbers in [the evaluation](../../docs/evaluation.md).
It runs Codex alone, Claude Code alone, and the pair on Exercism exercises from
the [Aider polyglot benchmark](https://github.com/Aider-AI/polyglot-benchmark),
then grades each result with the exercise's own tests. The agents never see
those tests.

Running it spends real money: one trial of the hard set costs about $20 of
Claude usage plus the Codex usage, which the Codex CLI does not report.

## Requirements

- Node.js 22.12 or later, `git`, the Codex CLI, and Claude Code, both signed in.
- Python 3 with `pytest`, Go, and Rust with Cargo, for building and grading.

## Steps

Run every command from this directory.

1. Fetch the benchmark at the commit the task sets were chosen from, and build
   the tasks:

   ```sh
   git clone https://github.com/Aider-AI/polyglot-benchmark .cache/polyglot-benchmark
   git -C .cache/polyglot-benchmark checkout 7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f
   node prepare.mjs
   ```

2. Check the toolchains. For every task, `preflight.mjs` confirms that the
   reference solution passes the hidden tests and the untouched stub fails them.
   It also fetches the Rust dependencies, because agents and grading run
   offline.

   ```sh
   node preflight.mjs
   ```

3. Pin the version under test. A run takes hours, and a worktree keeps edits to
   your checkout from changing it halfway through:

   ```sh
   git worktree add --detach ../../../collab-pinned HEAD
   export COLLAB_DIR="$(cd ../../../collab-pinned && pwd)"
   ```

   Without `COLLAB_DIR`, the harness runs this repository as it is.

4. Run the conditions, one trial per output directory. Keep the computer
   awake for the whole run: a sleeping machine drops the agents' model
   connections. On macOS, keep the lid open and use `caffeinate`:

   ```sh
   caffeinate -i node run-conditions.mjs --set hard --trial 1 --out runs/hard-t1
   caffeinate -i node run-conditions.mjs --set hard --trial 2 --out runs/hard-t2
   caffeinate -i node run-conditions.mjs --set hard --trial 3 --out runs/hard-t3
   caffeinate -i node run-conditions.mjs --set heldout --trial 1 --out runs/heldout-t1
   ```

   Each result is appended to `results.jsonl` as it finishes. Rerunning the same
   command resumes and skips finished jobs.

5. Summarize:

   ```sh
   node analyze.mjs runs/hard-t1
   node variance.mjs runs/hard-t1 runs/hard-t2 runs/hard-t3
   ```

   `analyze.mjs` reports pass rates with Wilson intervals and paired McNemar
   tests for one trial. `variance.mjs` reports the mean and standard deviation
   across trials and how often each task changed outcome.

## Task sets

- [`selection.json`](selection.json): the 20-task hard set and the rule that
  chose it. `screen.mjs` ran Claude Haiku 4.5 once on every task and wrote
  [`screen.json`](screen.json). `screen2.mjs` then ran Claude Sonnet 5 on the
  exercises Haiku failed while passing at least one test, wrote
  [`screen2.json`](screen2.json), and applied the rule.
- [`heldout.json`](heldout.json): the 21 exercises from the second screen that
  the hard set does not use. They were chosen after the hard-set runs and were
  never used to change the protocol.

## What the harness controls

- Every condition gets the same prompt ([`prompt.mjs`](prompt.mjs)) and the same
  offline toolchain environment ([`agent.mjs`](agent.mjs)). Web search is off
  and both sandboxes block the network.
- Codex runs with `--ignore-user-config --ignore-rules`, so your Codex settings
  and execpolicy rules do not apply. Claude Code still loads your global
  `CLAUDE.md`, and Codex still loads your `AGENTS.md` and skills, in every
  condition.
- The pair runs `model-collab up --ui workers` with a 25-minute session and a
  15-minute turn limit, with project memory off.
- Two kinds of job are infrastructure failures, not results: a Codex run that
  prints nothing for 10 minutes while no command is running, which has lost its
  model stream, and on macOS a job the computer slept through, found in the
  `pmset` power log. The pair's worker first retries a stalled turn itself. The
  harness then discards such an attempt and runs the job once more from a
  fresh workspace; `infraRetries` records it. A job whose second attempt fails
  the same way is recorded with `stalled` or `slept` set and counts as a
  failure.
- Grading copies the final workspace without build caches, deletes any test
  files the agent wrote, and restores the exercise's support files and hidden
  tests before running them.
