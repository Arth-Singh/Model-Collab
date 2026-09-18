# RL pilot: all four conditions passed

On 2026-09-19 KST, all four conditions passed **27/27 GAE checks** in one task and one trial. No correctness gain from discussion was observed. One distinct task provides no across-task confidence interval; this is a successful harness pilot, not evidence of better RL research. Timings below are descriptive: pair rounds ran in parallel while solo refinement was sequential; execution order, service latency, and cache effects were not controlled.

| Condition | Final cases | CLI launches | Input tokens | Output tokens | Total tokens | Wall seconds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| solo-codex | 27/27 | 4 | 45,836 | 2,463 | 48,299 | 92.906 |
| solo-claude | 27/27 | 4 | 22,251 | 7,727 | 29,978 | 88.487 |
| independent-pair | 27/27 | 4 | 33,312 | 5,116 | 38,428 | 54.113 |
| collaboration | 27/27 | 4 | 34,455 | 3,878 | 38,333 | 49.347 |

Exactly **16 attempted and confirmed CLI launches**, zero failures, zero skips, and complete reported token coverage (155,038 tokens). Total run time was 284.960 seconds. The harness made no retries or additional evaluation calls; any retries inside the native clients are unobserved.

Each condition received four invocation allowances and a 90-second per-call timeout. Both pair conditions ran two parallel drafts and two parallel revisions; only collaboration shared prior-round peer candidates. Claude was the final submitter in both pair conditions, fixed before results. Private tests never entered prompts or selected a winning candidate.

The paired accuracy difference was **0 percentage points** against each baseline. There was one complete task/trial pair per comparison. A bootstrap interval is deliberately unavailable: 27 grader cases are not 27 independent research samples. Wall times are descriptive observations; parallelism, model mixture, caching, and service latency prevent attributing the observed timings to discussion. Equal call allowances did not equalize tokens or cost.

Requested settings were Codex `gpt-6-astra` and Claude `claude-fable-5-1[1m]`, both with requested `xhigh` effort. Claude emitted observed model ID `claude-fable-5-1`; Codex emitted no model ID. Applied effort and the requested context-window suffix were not independently confirmed by client output. Input-token totals include reported cache reads and writes. No cost estimate was made.

The [pre-execution manifest](rl-pilot-manifest.json) records specifications, fixed schedule, limits, analysis plan, and source hashes. Its hash is:

``a5f90113f1d4ea96afc3ad22441520fa9c30936622d367bd95810006c4305884``

All recorded source hashes still matched at completion. This local record is not an independently timestamped public registration. [Public results JSON](rl-pilot-results.json) contains derived metrics and final candidate code; raw CLI events and client session identifiers remain in ignored `eval-results/`.

Six RL implementation tasks and 166 deterministic cases are prepared; **only GAE was run against real models** in this pilot. See [methods and primary sources](RL-BENCHMARK.md), the [larger study plan](../docs/rl-study-plan.json), and the [earlier deadline-affected experiment](RESULTS.md). No broader study or RL training experiment was performed.
