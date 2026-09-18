const average = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const valid = run => run.executionStatus === 'complete' && Number.isInteger(run.grade?.total);
const success = run => run.grade?.correct === true;

function usageTotal(calls) {
  const known = calls.filter(call => call.usage);
  const totals = known.length ? { input: 0, output: 0, cachedInput: 0, cacheCreation: 0, total: 0 } : null;
  for (const call of known) for (const key of Object.keys(totals)) totals[key] += call.usage[key] ?? 0;
  return { knownCalls: known.length, attemptedCalls: calls.filter(call => call.attempted).length, knownUsageTotals: totals, total: calls.filter(call => call.attempted).every(call => call.usage) ? totals : null };
}

/** Resample distinct tasks, preserving their within-task trial averages. */
export function taskClusterBootstrap(taskDifferences, { samples = 2000, seed = 20260919 } = {}) {
  if (!Number.isInteger(samples) || samples < 100 || samples > 100_000) throw new Error('bootstrap samples must be between 100 and 100000');
  const mean = average(taskDifferences);
  if (taskDifferences.length < 2) return { mean, interval95: null, distinctTasks: taskDifferences.length, samples: 0, seed, unit: 'distinct_task', limitation: 'At least two distinct tasks are needed; one task cannot support across-task uncertainty.' };
  const next = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const initialSeed = seed, distribution = [];
  for (let i = 0; i < samples; i++) distribution.push(average(taskDifferences.map(() => taskDifferences[Math.floor(next() * taskDifferences.length)])));
  distribution.sort((a, b) => a - b);
  return { mean, interval95: [distribution[Math.floor(.025 * (samples - 1))], distribution[Math.ceil(.975 * (samples - 1))]], distinctTasks: taskDifferences.length, samples, seed: initialSeed, unit: 'distinct_task', limitation: 'Descriptive task-cluster percentile bootstrap; few related synthetic tasks give limited, possibly degenerate uncertainty and no population-wide guarantee.' };
}

export function summarizeEvaluation(report, options = {}) {
  const results = report.results ?? [], modeNames = report.config?.modes ?? [...new Set(results.map(run => run.mode))];
  const modes = modeNames.map(mode => {
    const runs = results.filter(run => run.mode === mode), usable = runs.filter(valid), calls = runs.flatMap(run => run.calls ?? []);
    const usage = usageTotal(calls), attempted = calls.filter(call => call.attempted), failed = attempted.filter(call => call.error);
    const taskIds = [...new Set(runs.map(run => run.taskId))];
    const taskAccuracies = taskIds.flatMap(taskId => {
      const eligible = usable.filter(run => run.taskId === taskId);
      return eligible.length ? [average(eligible.map(run => +success(run)))] : [];
    });
    return { mode, runs: runs.length, validRuns: usable.length, incompleteRuns: runs.filter(run => run.executionStatus !== 'complete').length,
      correct: usable.filter(success).length, incorrect: usable.filter(run => !success(run)).length,
      accuracy: average(taskAccuracies), accuracyDefinition: 'Mean of per-task accuracy among complete, graded runs; excludes incomplete runs',
      operationalSuccessRate: average(runs.map(run => +success(run))),
      wallMs: runs.reduce((n, run) => n + (run.wallMs ?? 0), 0),
      modelCalls: attempted.length, attemptedCalls: attempted.length, launchedCalls: calls.filter(call => call.launched === true).length,
      launchUnknownCalls: attempted.filter(call => call.launched == null).length, skippedCalls: calls.filter(call => !call.attempted).length,
      failedCalls: failed.length, callFailureRate: attempted.length ? failed.length / attempted.length : null,
      timingInvalidRuns: runs.filter(run => (run.deadlineOverrunMs ?? 0) > 1000).length,
      usage: usage.total, usageCoverage: usage,
    };
  });
  const perTask = results.map(run => ({ taskId: run.taskId, trial: run.trial, mode: run.mode, executionStatus: run.executionStatus, outcome: run.outcome, validForAlgorithmComparison: valid(run), correct: Number.isInteger(run.grade?.total) ? success(run) : null, passedTests: run.grade?.passed ?? null, totalTests: run.grade?.total ?? null, counters: run.counters, wallMs: run.wallMs }));
  const pairedComparisons = modeNames.filter(mode => mode !== 'collaboration').map(baseline => {
    const pairs = results.filter(run => run.mode === 'collaboration').flatMap(peer => {
      const solo = results.find(run => run.mode === baseline && run.taskId === peer.taskId && run.trial === peer.trial);
      return solo ? [{ taskId: peer.taskId, trial: peer.trial, usable: valid(peer) && valid(solo), difference: +success(peer) - +success(solo), peer, solo }] : [];
    });
    const eligible = pairs.filter(pair => pair.usable), ids = [...new Set(eligible.map(pair => pair.taskId))];
    const differences = ids.map(taskId => average(eligible.filter(pair => pair.taskId === taskId).map(pair => pair.difference)));
    const operationalIds = [...new Set(pairs.map(pair => pair.taskId))];
    return { treatment: 'collaboration', baseline, plannedPairs: pairs.length, completePairs: eligible.length, excludedIncompletePairs: pairs.length - eligible.length,
      algorithmAccuracyDifference: taskClusterBootstrap(differences, options),
      operationalSuccessDifference: average(operationalIds.map(taskId => average(pairs.filter(pair => pair.taskId === taskId).map(pair => pair.difference)))),
      perTaskDifferences: ids.map((taskId, i) => ({ taskId, difference: differences[i], completeTrials: eligible.filter(pair => pair.taskId === taskId).length })),
      caveat: 'Complete-pair analysis can be selection-biased when failures differ. Operational success includes failures and is not pure algorithm quality. Test cases are never treated as independent research samples.',
    };
  });
  return { modes, perTask, pairedComparisons };
}

const percent = value => value == null ? 'unknown' : `${(100 * value).toFixed(1)}%`;
const escapeCell = text => String(text).replaceAll('|', '\\|').replaceAll('\n', ' ');

export function renderEvaluationMarkdown(report) {
  const summary = report.analysis ?? summarizeEvaluation(report);
  const lines = [
    '# RL implementation evaluation report', '',
    `Run: ${report.runId}. Manifest SHA-256: \`${report.manifest?.manifestHash ?? 'unavailable'}\`.`,
    `Started: ${report.startedAt}. Status: ${report.status ?? 'unknown'}.`, '',
    `Requested models: Codex \`${report.config?.models?.codex ?? 'unspecified'}\`; Claude \`${report.config?.models?.claude ?? 'unspecified'}\`. Requested effort: \`${report.config?.effort ?? 'unspecified'}\`. Applied effort is not independently confirmed by these CLIs.`,
    `Observed model IDs emitted by providers: ${[...new Set((report.results ?? []).flatMap(run => (run.calls ?? []).flatMap(call => call.observedModelIds ?? [])))].join(', ') || 'not emitted'}.`, '',
    'These tasks measure correctness of small RL-related implementations. They do not measure learned-agent returns, research novelty, or general research ability.', '',
    '| Mode | Complete / planned runs | Task-macro accuracy (complete runs) | Operational output success | Attempted / launched calls | Call failures | Wall seconds | Known tokens / usage coverage |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ];
  if (report.config?.providerKind === 'injected') lines.splice(5, 0, 'Provider mode: injected/custom. Mock outputs are not evidence about real model performance.', '');
  for (const mode of summary.modes) lines.push(`| ${mode.mode} | ${mode.validRuns} / ${mode.runs} | ${percent(mode.accuracy)} | ${percent(mode.operationalSuccessRate)} | ${mode.attemptedCalls} / ${mode.launchedCalls}${mode.launchUnknownCalls ? ` (+${mode.launchUnknownCalls} unknown)` : ''} | ${mode.failedCalls} | ${(mode.wallMs / 1000).toFixed(2)} | ${mode.usageCoverage.knownUsageTotals?.total ?? 'unknown'} / ${mode.usageCoverage.knownCalls} of ${mode.attemptedCalls} calls |`);
  lines.push('', '## Paired comparisons', '', 'Differences are collaboration minus baseline. Trials are averaged within each task before task-cluster bootstrap. Hidden test cases are not independent samples.');
  for (const comparison of summary.pairedComparisons) {
    const estimate = comparison.algorithmAccuracyDifference;
    lines.push('', `- ${comparison.baseline}: ${comparison.completePairs}/${comparison.plannedPairs} complete pairs across ${estimate.distinctTasks} tasks; difference ${percent(estimate.mean)}; 95% task-bootstrap interval ${estimate.interval95 ? estimate.interval95.map(percent).join(' to ') : 'unavailable'}. ${comparison.excludedIncompletePairs} incomplete pairs excluded.`);
  }
  lines.push('', '## Every task and trial', '', '| Task | Trial | Mode | Execution | Outcome | Hidden cases |', '| --- | ---: | --- | --- | --- | ---: |');
  for (const run of summary.perTask) lines.push(`| ${escapeCell(run.taskId)} | ${run.trial} | ${run.mode} | ${run.executionStatus} | ${run.outcome} | ${run.totalTests == null ? 'not graded' : `${run.passedTests}/${run.totalTests}`} |`);
  lines.push('', '## Interpretation limits', '', ...(report.limitations ?? []).map(text => `- ${text}`), '', 'No automatic posting occurs. Review raw failures and the manifest before sharing this report.', '');
  return lines.join('\n');
}

export function renderTwitterDraft(report) {
  const analysis = report.analysis ?? summarizeEvaluation(report), distinct = new Set((report.results ?? []).map(run => run.taskId)).size;
  const comparison = analysis.pairedComparisons.find(item => item.baseline === 'independent-pair');
  const incomplete = analysis.modes.reduce((n, mode) => n + mode.incompleteRuns, 0);
  const estimate = comparison?.algorithmAccuracyDifference;
  const evidence = !comparison || !estimate?.interval95 || incomplete ?
    `Comparison remains inconclusive: ${incomplete} incomplete runs; ${comparison?.completePairs ?? 0} complete discussion/no-message pairs.` :
    `Discussion vs no-message pair: ${(100 * estimate.mean).toFixed(1)} percentage-point accuracy difference; task-bootstrap 95% interval [${estimate.interval95.map(x => (100 * x).toFixed(1)).join(', ')}].`;
  return `DRAFT — not posted${report.config?.providerKind === 'injected' ? '\nInjected/custom provider run: do not present mock data as model results.' : ''}\n\nWe tested bounded Codex/Claude discussion on ${distinct} synthetic RL implementation tasks, alongside solo refinement and an independent no-message pair. ${evidence}\n\nEqual invocation allowances, not equal tokens or cost. These are code-correctness tasks, not RL training or general research performance. Small, related task set; uncertainty and every failure are in the report. No broad superiority claim.\n\nManifest: ${report.manifest?.manifestHash ?? 'unavailable'}\n`;
}
