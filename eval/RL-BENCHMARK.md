# RL implementation benchmark and analysis plan

This suite tests six small, verifiable pieces of reinforcement-learning code. It
measures implementation correctness under bounded model collaboration. It does
not train policies, measure environmental returns, evaluate research novelty, or
establish that agents can conduct RL research independently.

## Tasks and mathematical sources

| Task ID | What must be handled correctly | Private cases | Oracle formulation |
| --- | --- | ---: | --- |
| `rl-gae-boundaries` | Distinct bootstrap and trace masks; termination, truncation, reset boundaries, rollout ends | 27 | Direct finite sum of weighted TD residuals |
| `rl-nstep-targets` | Reward horizon, terminal suppression, truncated/final-observation bootstrap | 27 | Backward nesting of finite returns |
| `rl-ppo-clipped` | Negative advantages, masked normalization, policy/value clipping, diagnostics | 29 | Sign-dependent piecewise policy objective |
| `rl-tabular-bellman` | Stochastic actions/outcomes, synchronous evaluation, terminal edges, horizon zero | 26 | Exponentiation of an augmented affine Bellman matrix |
| `rl-vtrace` | Separate importance clips, trace coefficient, policy advantage, episode boundaries | 27 | Direct sum/product expansion of V-trace corrections |
| `rl-experiment-aggregate` | Fixed-budget checkpoints, duplicate-step rules, seed counts, missing runs, task weighting | 30 | Sorted checkpoint selection and pairwise variance identity |

The suite has **166 deterministic hidden cases across six distinct tasks**. Cases
are grader checks, not 166 independent research samples. Independent QA solutions
use different computational forms; each task also has an intentional bug mutation
that its private tests must reject. Hand-calculated cases anchor important masks,
Bellman values, and summary statistics. This verifies the harness, not model skill.

GAE follows the discounted residual sum in equation 16, while the finite return
construction follows equations 11–14 in [Schulman et al., *Generalized Advantage
Estimation*](https://arxiv.org/html/1506.02438v6). Bootstrap suppression distinguishes
termination from external truncation, as described by [Gymnasium's time-limit
guide](https://gymnasium.farama.org/tutorials/gymnasium_basics/handling_time_limits/).
Both episode-ending flags stop traces from leaking into reset episodes. The
benchmark supplies final-observation values explicitly to avoid reset ambiguity.

The PPO policy objective follows [Schulman et al., *Proximal Policy Optimization
Algorithms*](https://arxiv.org/abs/1707.06347) and the sign-sensitive clipped
objective in [OpenAI's PPO documentation](https://spinningup.openai.com/en/latest/algorithms/ppo.html).
The task explicitly specifies its masked normalization, value-loss clipping, and
approximate-KL conventions; those are benchmark choices, not a claim that every
PPO implementation uses identical auxiliary losses or diagnostics.

The Bellman task uses the expectation backup described in [OpenAI's RL key
concepts](https://spinningup.openai.com/en/latest/spinningup/rl_intro.html), including
a policy-weighted average rather than a maximizing backup. The V-trace task uses
the residual products and recursive identity in section 4 of [Espeholt et al.,
*IMPALA*](https://arxiv.org/html/1802.01561v3), with its clipping and boundary
conventions stated in full in the public specification.

[Agarwal et al., *Deep Reinforcement Learning at the Edge of the Statistical
Precipice*](https://arxiv.org/html/2108.13264v4) motivates reporting uncertainty and
robust aggregates instead of relying on point estimates alone. Our checkpoint
aggregation task defines its own reproducible task-mean IQM, including fractional
trimming. Our evaluation report uses a task-cluster bootstrap for paired code
accuracy; this is not a reproduction of that paper's training experiments or an
implementation of every estimator in its analysis library.

## Four conditions

Every condition receives the same total invocation allowance and timeout per
invocation. An even budget is required for pair conditions.

1. `solo-codex`: all calls go to Codex; each later call reviews its previous candidate.
2. `solo-claude`: the corresponding Claude-only self-refinement condition.
3. `independent-pair`: Codex and Claude each receive half the calls. First drafts
   and later self-refinements run in parallel. Neither sees the other's output.
4. `collaboration`: the same model mixture, allocation, round concurrency, and
   predetermined final submitter, with prior-round peer candidates included in
   revision prompts.

The primary contrast is **collaboration versus independent-pair**, because it
changes message exchange while preserving model mixture and parallel allocation.
Solo comparisons are secondary. Both pair conditions use the same final submitter
for each task/trial; it alternates across tasks and trials before any result is
seen. The final artifact is that submitter's last valid candidate. There is no
hidden-test selection, no post-hoc peer swap, and no extra call to break ties.

A two-call pair budget contains independent drafts only. Use four or more calls
to measure the implemented exchange-and-revision treatment. Equal invocation
allowances do not guarantee equal tokens, cost, or underlying API requests.
Neither CLI exposes a guaranteed model-randomness seed, and repeated trials should
not be described as independently seeded training runs.

## Local preregistration and execution controls

`createEvaluationManifest(options)` makes a dry plan without invoking models. Its
manifest includes complete public specifications, specification hashes, fixed
mode/submitter schedule, requested model/effort, call and time limits, bootstrap
settings, analysis definitions, and SHA-256 hashes of grading and runner sources.
`configHash` excludes the creation timestamp; `manifestHash` identifies the full
record. `runEvaluation` writes a manifest before the first provider attempt.
This is a local pre-execution record, not an independently timestamped public
registration or evidence that an operator could not alter files afterward.

`maxTotalCalls` must cover the entire balanced plan; choosing a smaller cap fails
before calls rather than silently favoring early conditions. `globalTimeoutMs`, an
optional absolute `deadlineMs`, and `AbortSignal` stop remaining work. The bundled
adapter terminates its subprocess group on cancellation; custom providers must
cooperate with the signal. An optional `stopAfterInitialInfrastructureFailures`
ends the run when every one of the first specified attempts fails at the provider
layer. Skipped conditions stay visible in the result schedule.

The JSON report is atomically replaced after events, and an append-only JSONL
journal is flushed with `fsync`. The immutable manifest is written separately.
Records distinguish scheduled calls, adapter attempts, confirmed CLI launches,
unknown launch status, skipped calls, malformed responses, provider failures,
incorrect code, and grader failures. Reports preserve requested model/effort and
provider-emitted model IDs separately. An applied effort override is not inferred
from a requested flag when the client does not report it.

Process timers need an executing host. Machine suspension or process scheduling
can delay timeout enforcement. The earlier experiment in [RESULTS.md](RESULTS.md)
records this failure honestly. No software timeout in this process is an external
wall-clock watchdog while its host is suspended. A shutdown grace period allows
cooperative subprocess termination; the global deadline prevents subsequent work
when the process can run again.

## Prespecified outcomes and uncertainty

Whole-task correctness means passing every private case. Algorithm accuracy is
computed only for complete, graded runs; malformed outputs, skipped calls, and
provider/grader failures are not mislabeled algorithm mistakes. A run with a valid
final candidate but an earlier failed scheduled call remains incomplete for the
controlled algorithm comparison. Its observed candidate score is still shown.

The primary paired analysis matches task and trial, excludes pairs unless both
conditions completed, averages trial differences within each task, then weights
distinct tasks equally. The descriptive 95% percentile interval resamples these
task-level differences with a fixed bootstrap seed. Hidden cases never enter the
resampling unit. One distinct task produces no across-task interval. Six related
synthetic tasks also provide limited generalization; degenerate intervals do not
prove certainty. Differential failures can bias complete-pair analysis, so the
report also shows missingness and operational output success over all planned runs.

Token usage comes only from provider reports. Unknown totals remain `null`, with
known subtotals and coverage shown. Cost estimates require explicit supplied
prices and carry an estimate label. Wall time includes CLI startup and service
latency; concurrency differs between pair and solo conditions.

## Recommended progression

First run unit/mutation tests. Then run a small, authorized pilot to validate
actual adapters, completion rates, timing, and manifests. Expand to all six tasks
and several trials only after choosing an explicit call/time budget and inspecting
pilot failures. For example, six tasks × four conditions × four calls × five
trials requires **480 invocation allowances**. That is a plan, not a run performed
by this repository's tests.

A publishable report should include every planned condition, provider failures,
missing usage, task-level outcomes, the manifest, and the exact scope of any
inference. A generated Twitter draft is a local draft only. No tool posts it, and
one successful task cannot support a claim that discussion improves RL research.
