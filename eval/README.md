# Bounded evaluations

The `coding` suite contains three algorithm tasks. The `rl` suite contains six
verifiable RL implementation tasks and 166 deterministic private cases. See
[RL-BENCHMARK.md](RL-BENCHMARK.md) for definitions, primary sources, experimental
conditions, analysis, and limitations. The earlier deadline-affected experiment
remains in [RESULTS.md](RESULTS.md).

```js
import { createEvaluationManifest, runEvaluation } from '../src/eval.js';

const options = {
  suite: 'rl',
  tasks: ['rl-gae-boundaries'], // omit for all six RL tasks
  modes: ['solo-codex', 'solo-claude', 'independent-pair', 'collaboration'],
  callBudget: 4,
  trials: 1,
  timeoutMs: 90_000,
  maxTotalCalls: 16,
  globalTimeoutMs: 20 * 60_000,
  stopAfterInitialInfrastructureFailures: 2,
  outputDir: 'eval-results',
};
const plan = await createEvaluationManifest(options); // no model calls
console.log(plan.config.plannedCalls, plan.configHash);
// Calling runEvaluation consumes the installed clients' normal model allowance.
const report = await runEvaluation({ ...options, onProgress: console.log });
console.table(report.summary);
```

Default requested models are `gpt-6-astra` and `claude-fable-5-1[1m]`, both with
requested `xhigh` effort. `models: {codex, claude}` and `effort` override these.
Observed provider model IDs are recorded separately when emitted; an applied
effort override is not independently confirmed by the current adapter output.

The real adapters invoke `codex exec` and `claude -p` using existing authentication,
without a shell or permission bypass, in an empty disposable directory. Tools
are disabled. Private tests never enter prompts or the provider workspace. Output
is capped and subprocess groups are cancelled on limits. Node VM contains common
accidental code hangs but is not a security sandbox for hostile code; use an OS
sandbox for hostile providers or candidate code.

Every mode receives equal aggregate call allowance. Solo modes self-refine;
`independent-pair` has the same two-model allocation and final submitter as
`collaboration`, but receives no peer messages. Collaboration uses bounded
prior-round snapshots. Pair budgets must be even; four or more calls are needed
for actual exchange. Final selection is fixed before grading. No hidden-test
feedback, best-of-test selection, or unbounded discussion occurs.

Manifest and raw artifacts are local and may contain prompts, outputs, and client
session identifiers. Keep raw artifacts ignored and review before sharing. Reports
are written incrementally, with separate attempt/launch/skip counts. Unknown token
usage stays `null`; user-supplied prices enable explicitly labeled estimates only.

## API

- `createEvaluationManifest(options)` creates a no-call hashed plan.
- `runEvaluation({suite?, tasks?, modes?, callBudget?, trials?, timeoutMs?,
  maxTotalCalls?, globalTimeoutMs?, deadlineMs?, signal?,
  stopAfterInitialInfrastructureFailures?, outputDir?, provider?, models?, effort?,
  prices?, commands?, bootstrapSamples?, bootstrapSeed?, onProgress?})` runs the
  plan. `tasks` accepts IDs or public task objects. Default suite is `coding`;
  `all` includes both suites. Default global limit is 30 minutes.
- `runTask({task, mode, callBudget?, timeoutMs?, provider?, models?, effort?,
  finalProvider?, prices?, commands?, deadlineMs?, signal?, onCallEvent?})` runs one
  task. Its absolute deadline is also bounded by the invocation allowance.
- `gradeSolution(taskId, solution, {timeoutMs?, testTimeoutMs?, deadlineMs?, signal?})`
  runs private tests in a separate process.
- `summarizeEvaluation(report)` produces task/trial outcomes and paired differences.
- `renderEvaluationMarkdown(report)` and `renderTwitterDraft(report)` return text;
  neither publishes anything.

An injected provider receives `{provider, model, effort, prompt, timeoutMs,
 deadlineMs, signal, onLaunch}` and returns `{solution, summary, usage?, raw?,
 launched?, observedModelIds?}` or `{error, ...}`. Call `onLaunch()` only when an
actual provider process/request has launched, or return a boolean `launched`.
Absent launch evidence remains unknown. Usage is
`{input, output, cachedInput, cacheCreation, total}`; input includes cache reads and
writes. Custom providers must cooperate with cancellation. Injected-provider
reports are labeled and must not be presented as evidence about real models when
outputs were mocked.

`node --test test/eval.test.js` checks independent RL oracles, bug mutations,
information boundaries, budgets, manifests, durability, cancellation, uncertainty,
reporting, and subprocess failures without spending model credits.
