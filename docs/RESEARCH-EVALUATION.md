# Evaluating collaborative research without overstating the result

The first study should answer a narrow question: does exchanging peer feedback
improve correctness on verifiable RL reasoning and implementation tasks at a
declared resource allowance? It does not measure discovery of novel RL algorithms
or the quality of an entire research project.

## Conditions and units

Compare Codex alone, Claude alone, an independent pair with no message exchange,
and a collaborating pair. Give each condition the same aggregate CLI invocation
allowance. Solo agents spend extra invocations on self-review. Pair conditions
divide that allowance between peers; the final submitter is chosen before grading
and rotated across tasks/trials. Do not select the winner by hidden-test score.

The independent-pair condition uses the same preselected final submitter and
allocation as collaboration. It isolates peer-message exposure; it is not an
oracle best-of-two baseline. Adding a best-of-two baseline requires a separate,
predeclared selection procedure and must not use private tests to choose.

Report actual tokens, wall time, launched calls, failed calls, incomplete runs,
and usage coverage. Equal invocation allowances are not equal tokens, dollars,
or internal API requests. Report those differences rather than presenting the
study as a compute-matched comparison.

The unit of generalization is a distinct research task, not an individual hidden
test case. Repeated trials help characterize stochasticity but do not turn six
task families into hundreds of independent research problems. Confidence
intervals and paired comparisons should cluster by task. A single-task pilot
cannot establish a general advantage, even when it passes many hidden cases.

## RL suite

The initial suite covers GAE boundaries, n-step targets, PPO clipping, tabular
Bellman updates, V-trace corrections, and aggregation across environments/seeds.
Each task has an explicit public specification and deterministic private tests.
References and exact conventions live alongside the suite. Test results are
never passed back into candidate refinement.

Before a real run, freeze the task IDs, specifications, models, effort, condition
order, final-submitter schedule, call allowance, per-call timeout, global deadline,
and selection rule. Save the manifest and hash before the first provider call.
Retain every result, including infrastructure failures. Do not silently rerun a
failed condition until a preferred narrative emerges.

Use the pilot to assess task difficulty and infrastructure. Changes motivated by
pilot observations belong to a new, clearly versioned confirmatory study. Do not
combine changed tasks or revised grading rules with the old run as one estimate.

## Scaling beyond verifiable implementation

The saved [six-task study plan](rl-study-plan.json) schedules 480 CLI invocations:
six tasks, four conditions, five trials, and four calls per condition. It requests
the same model IDs and xhigh effort as the pilot, with a four-hour global ceiling.
This is a preview only; none of those calls are authorized or launched by creating
the plan. Repeated trials still leave only six distinct tasks. Review the pilot
before deciding whether this suite is difficult enough to justify that spend.

A stronger research study needs many independent held-out questions and realistic
artifacts: paper claims to audit, experiment plans to critique, mathematical
counterexamples, and repository-level bug fixes. For open-ended judgments, use
blinded domain reviewers, a predefined rubric, and randomized answer order.
Keep correctness, novelty, feasibility, citation support, and reproducibility
as separate outcomes. A peer model's agreement is not a ground-truth label.

For proposed algorithm improvements, run the actual controlled RL experiments
with comparable training budgets, multiple seeds, held-out evaluation, appropriate
uncertainty, and disclosed failures before claiming improved RL performance.
Discussion quality and algorithm performance are different outcomes.

The statistical cautions follow the primary analysis in
[Deep Reinforcement Learning at the Edge of the Statistical Precipice](https://arxiv.org/abs/2108.13264).
Termination/truncation conventions follow the environment's documented semantics;
see [Gymnasium's time-limit guidance](https://gymnasium.farama.org/tutorials/gymnasium_basics/handling_time_limits/).

## Public reporting

A defensible post states the task family, number of independent tasks and trials,
models, actual budgets, comparison conditions, observed results, and limitations.
Link the manifest, protocol, grading code, and an auditable result summary.
Do not say “collaborative research is better” based on a transport demo or one
successful coding exercise. A tool-launch announcement remains valid even when
the performance comparison is inconclusive.

Generated post drafts are local files for the user to review and publish; this
package never posts to social media automatically.
