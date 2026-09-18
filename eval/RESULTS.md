# First real evaluation — 2026-09-18

**The comparison did not complete under comparable operating conditions.** Solo
Codex returned a solution passing all 31 hidden cases. Solo Claude and the peer
run returned no valid candidate before timeout/deadline failures. Large observed
timer delays and a connection failure prevent interpreting this as evidence for
or against collaboration, or as a valid speed comparison. No runs were repeated.

## Configuration

- Task: `weighted-intervals`, one task and one trial.
- Codex: `gpt-6-astra`, `xhigh` effort.
- Claude: `claude-fable-5-1[1m]`, `xhigh` effort.
- Budget: four scheduled provider invocations per mode; 12 attempts maximum.
- Requested timeout: 120 seconds per invocation; absolute mode deadline of
  480 seconds. The deadline check rejected later invocations after elapsed time
  exceeded that limit.
- Grading: 31 private cases, including zero-value tie-breaking, touching
  half-open intervals, negative values, input permutations, and 2,000 jobs.
  A fresh VM runs each case with a 150 ms timeout.
- Peers were to draft independently, then revise from prior-round snapshots.
  Claude was the final submitter, selected before results were available.
  Private grading never influenced prompts or candidate selection.

## Observed results

| Mode | Final grading | Scheduled / launched calls | Valid responses | Failures | Observed wall time |
| --- | --- | ---: | ---: | --- | ---: |
| Solo Codex | 31 / 31 passed | 4 / 4 | 3 | 1 timeout | 345.408 s |
| Solo Claude | Not graded: no candidate | 4 / 2 | 0 | 2 timeouts; 2 deadline skips | 1,168.156 s |
| Collaboration | Not graded: no candidate | 4 / 2 | 0 | 2 timeouts; 2 deadline skips | 1,066.033 s |

The raw report's `modelCalls` field counts scheduled adapter invocations, including
attempts rejected before a CLI process launched. Thus there were 12 recorded
attempts, eight launched CLI processes, three valid responses, five timeouts,
and four pre-launch deadline skips. Internal API request counts are unknown.
The peer revision round never launched, so this run did **not** measure the
effect of exchanging or revising solutions.

| Mode | Known input tokens | Known output tokens | Known total | Usage coverage |
| --- | ---: | ---: | ---: | --- |
| Solo Codex | 34,865 | 7,121 | 41,986 | 3 of 4 attempts |
| Solo Claude | Unknown | Unknown | Unknown | 0 of 4 attempts |
| Collaboration | Unknown | Unknown | Unknown | 0 of 4 attempts |

These are provider-reported usage values, not estimates. Complete token totals
remain `null`; timed-out calls may have consumed additional unreported tokens.
No prices were supplied, so no cost estimate was calculated.

## Timing and operational limits

The run started at `2026-09-18T11:52:17.588Z` and completed at
`2026-09-18T12:35:17.191Z` (20:52–21:35 KST), an observed 2,579.603 seconds.
Some timeout callbacks and process exits occurred much later than their requested
120-second deadlines: the longest pair of calls lasted approximately 1,066
seconds. The record establishes delayed timeout enforcement; it does not establish
whether host suspension, process scheduling, or another environmental interruption
caused the delay. JavaScript timers cannot provide an external wall-clock watchdog
while their host process is suspended or unable to run.

The collaborative Codex call also logged a connection failure while refreshing
available models. A separate local two-worker demonstration was running during
part of this experiment, so resource and service contention were not controlled.
All failed attempts remain in the raw artifact; no extra attempts were made to
replace them.

Even an uninterrupted run of one synthetic task would not establish general
superiority. The intended design equalizes invocation allowances and per-call
timeouts, not tokens, dollars, or guaranteed underlying API requests. Peer calls
run in parallel while solo refinement is sequential. Here, deadline skips also
prevented equal numbers of launched calls. Neither quality rankings nor speedup
claims are justified by these incomplete conditions.

## Local evidence

The complete prompts, candidate solutions, CLI events, failures, and usage are
stored locally in the ignored file:

`eval-results/2026-09-18T11-52-17.588Z-df238995-f579-4c51-a21b-30b92dbab6a1.json`

The earlier one-call-per-provider identity-function adapter smoke succeeded for
both requested models. Its raw evidence was moved to ignored
`eval-results/adapter-smoke.json`. That smoke verified CLI integration only; it
was not a problem-solving comparison.
