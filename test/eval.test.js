import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gradeSolution, runEvaluation, runTask, createEvaluationManifest, summarizeEvaluation, renderEvaluationMarkdown, renderTwitterDraft } from '../src/eval.js';
import { parseSolution, runProcess } from '../src/providers.js';
import { tasks, selectTasks } from '../eval/tasks.js';
import { privateRlTests } from '../eval/private-rl-tests.js';
import { rlSolutions } from '../eval/fixtures/rl-solutions.js';
import { taskClusterBootstrap } from '../eval/reporting.js';

// A deliberately simple list implementation, independent of the Map-based oracle.
const correctCache = `function solve(capacity, operations) {
  let entries = [];
  return operations.map(op => {
    const now = op[op.length - 1];
    entries = entries.filter(entry => entry.until === null || entry.until > now);
    if (op[0] === 'size') return entries.length;
    const index = entries.findIndex(entry => entry.key === op[1]);
    if (op[0] === 'get') {
      if (index === -1) return null;
      const [entry] = entries.splice(index, 1); entries.push(entry); return entry.value;
    }
    if (index !== -1) entries.splice(index, 1);
    if (capacity && (op[3] === null || op[3] > 0)) {
      entries.push({key: op[1], value: op[2], until: op[3] === null ? null : now + op[3]});
      if (entries.length > capacity) entries.shift();
    }
    return null;
  });
}`;
const usage = { input: 100, output: 20, cachedInput: 10, cacheCreation: 0, total: 120 };
const valid = () => ({ solution: correctCache, summary: 'Expire before every operation; list order represents access order.', usage });

test('private grader accepts correct cache and rejects a plausible TTL bug', async () => {
  const good = await gradeSolution('ttl-lru', correctCache);
  assert.equal(good.correct, true);
  assert.equal(good.passed, good.total);
  const bad = await gradeSolution('ttl-lru', correctCache.replace('entry.until > now', 'entry.until >= now'));
  assert.equal(bad.correct, false);
  assert.ok(bad.failures.length > 0);
});

test('grader bounds infinite code and hides host capabilities', async () => {
  const loop = await gradeSolution('ttl-lru', 'function solve() { while (true) {} }', { timeoutMs: 3000, testTimeoutMs: 10 });
  assert.equal(loop.correct, false);
  assert.ok(loop.failures.some(failure => failure.reason === 'timeout'));
  const host = await gradeSolution('ttl-lru', 'function solve() { return process.env; }');
  assert.equal(host.correct, false);
  assert.ok(host.failures.every(failure => failure.reason === 'runtime_error'));
});

test('all modes receive equal call budgets and no private feedback', async () => {
  for (const mode of ['solo-codex', 'solo-claude', 'independent-pair', 'collaboration']) {
    const received = [];
    const result = await runTask({ task: tasks[0], mode, callBudget: 4, provider: async request => {
      received.push(request);
      assert.equal(request.prompt.includes('cache-1'), false);
      assert.equal(request.prompt.includes('private-tests'), false);
      assert.equal(request.prompt.includes('wrong_answer'), false);
      assert.equal(typeof request.deadlineMs, 'number');
      return valid();
    } });
    assert.equal(received.length, 4);
    assert.equal(result.modelCalls, 4);
    assert.equal(result.grade.correct, true);
    assert.deepEqual(result.usage, { input: 400, output: 80, cachedInput: 40, cacheCreation: 0, total: 480 });
    assert.equal(result.estimatedCost, null);
    if (mode === 'collaboration') {
      assert.equal(received.filter(call => call.provider === 'codex').length, 2);
      assert.equal(received.filter(call => call.provider === 'claude').length, 2);
      assert.ok(received.slice(0, 2).every(call => call.prompt.includes('Solve independently')));
      assert.ok(received.slice(2).every(call => call.prompt.includes('peer candidates')));
    } else if (mode.startsWith('solo-')) {
      assert.ok(received.every(call => call.provider === mode.slice(5)));
      assert.ok(received.slice(1).every(call => call.prompt.includes('previous candidate')));
    }
  }
});

test('six RL oracles agree with independent implementations and reject domain bugs', async () => {
  const mutations = {
    'rl-gae-boundaries': ['d.terminated[t]?0:d.gamma*d.nextValues[t]', '(d.terminated[t]||d.truncated[t])?0:d.gamma*d.nextValues[t]'],
    'rl-nstep-targets': ['d.terminated[end]||d.truncated[end]', 'd.terminated[end]'],
    'rl-ppo-clipped': ['Math.min(r*a,clip(r,1-d.epsilon,1+d.epsilon)*a)', 'Math.max(r*a,clip(r,1-d.epsilon,1+d.epsilon)*a)'],
    'rl-tabular-bellman': ['d.policy[s][a]*value', 'value'],
    'rl-vtrace': ['Math.min(d.cClip,ratio)', 'Math.min(d.rhoClip,ratio)'],
    'rl-experiment-aggregate': ['point.step>=best.step', 'point.step>best.step'],
  };
  assert.equal(selectTasks(undefined, 'rl').length, 6);
  for (const task of selectTasks(undefined, 'rl')) {
    const good = await gradeSolution(task.id, rlSolutions[task.id]);
    assert.equal(good.correct, true, `${task.id}: ${JSON.stringify(good.failures)}`);
    assert.ok(good.total >= 25);
    const [before, after] = mutations[task.id];
    assert.ok(rlSolutions[task.id].includes(before));
    const bad = await gradeSolution(task.id, rlSolutions[task.id].replace(before, after));
    assert.equal(bad.correct, false, `Mutation survived: ${task.id}`);
  }
});

test('RL golden cases independently anchor termination, Bellman, and aggregation definitions', () => {
  const gae = privateRlTests('rl-gae-boundaries')[0].expected;
  assert.ok(Math.abs(gae.advantages[0] - 1.7) < 1e-12);
  assert.equal(gae.advantages[1], -5);
  assert.deepEqual(privateRlTests('rl-tabular-bellman')[0].expected.values, [2, 2.5]);
  const aggregate = privateRlTests('rl-experiment-aggregate')[0].expected;
  assert.equal(aggregate.tasks[0].mean, .5);
  assert.equal(aggregate.tasks[0].standardError, 1.5);
  assert.equal(aggregate.tasks[1].mean, 1.5);
  assert.equal(aggregate.macroMean, 1);
  assert.equal(aggregate.iqm, 1);
});

test('independent-pair matches allocation and final selection without peer-message leakage', async () => {
  const requests = [], counts = { codex: 0, claude: 0 };
  const result = await runTask({ task: tasks[0], mode: 'independent-pair', finalProvider: 'codex', provider: async request => {
    requests.push(request); counts[request.provider]++;
    return { ...valid(), summary: `${request.provider}-private-marker` };
  } });
  assert.deepEqual(counts, { codex: 2, claude: 2 });
  assert.equal(result.finalProvider, 'codex');
  for (const request of requests) {
    const other = request.provider === 'codex' ? 'claude' : 'codex';
    assert.equal(request.prompt.includes(`${other}-private-marker`), false);
  }
});

test('dry manifest fixes plan, source hashes, neutral submitters, and budgets without calls', async () => {
  let count = 0;
  const options = { suite: 'rl', trials: 2, provider: async () => { count++; return valid(); } };
  const a = await createEvaluationManifest(options), b = await createEvaluationManifest(options);
  assert.equal(count, 0);
  assert.equal(a.config.plannedCalls, 192);
  assert.equal(a.configHash, b.configHash);
  assert.equal(a.schedule.length, 48);
  assert.equal(a.manifestHash.length, 64);
  assert.ok(a.sourceHashes['eval/private-rl-tests.js']);
  for (const peer of a.schedule.filter(entry => entry.mode === 'collaboration')) {
    assert.equal(a.schedule.find(entry => entry.taskId === peer.taskId && entry.trial === peer.trial && entry.mode === 'independent-pair').finalProvider, peer.finalProvider);
  }
  await assert.rejects(createEvaluationManifest({ suite: 'rl', maxTotalCalls: 2 }), /planned calls/);
  await assert.rejects(createEvaluationManifest({ modes: ['collaboration'], callBudget: 3 }), /even/);
});

test('manifest and start event exist before first call, complete calls persist incrementally', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'model-collab-preregister-'));
  let invoked = 0;
  try {
    const report = await runEvaluation({ tasks: ['ttl-lru'], modes: ['solo-codex'], callBudget: 2, outputDir: directory, provider: async request => {
      invoked++;
      const { readdir } = await import('node:fs/promises');
      const files = await readdir(directory);
      assert.equal(files.filter(name => name.endsWith('.manifest.json')).length, 1);
      const journal = await readFile(join(directory, files.find(name => name.endsWith('.events.jsonl'))), 'utf8');
      assert.ok(journal.includes('call_start'));
      if (invoked === 2) assert.ok(journal.includes('call_complete'));
      request.onLaunch(); return { ...valid(), launched: true };
    } });
    assert.deepEqual(report.counters, { scheduled: 2, attempted: 2, launched: 2, launchUnknown: 0, skipped: 0 });
    assert.equal(report.status, 'complete');
    assert.equal(JSON.parse(await readFile(report.manifestPath, 'utf8')).manifestHash, report.manifest.manifestHash);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('initial infrastructure failure stop preserves all planned but skipped baselines', async () => {
  let calls = 0;
  const report = await runEvaluation({ tasks: ['ttl-lru'], stopAfterInitialInfrastructureFailures: 2, provider: async () => { calls++; return { error: 'connection_failed', launched: true }; } });
  assert.equal(calls, 2);
  assert.equal(report.counters.attempted, 2);
  assert.equal(report.counters.launched, 2);
  assert.equal(report.counters.skipped, 14);
  assert.equal(report.results.length, 4);
  assert.equal(report.stopReason, 'initial_provider_failures');
  assert.ok(report.analysis.modes.every(mode => mode.accuracy === null));
  assert.ok(report.analysis.pairedComparisons.every(pair => pair.completePairs === 0));
});

test('abort and absolute global deadline prevent launches and stop uncooperative providers', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const stopped = await runEvaluation({ tasks: ['ttl-lru'], signal: controller.signal, provider: async () => { calls++; return valid(); } });
  assert.equal(calls, 0); assert.equal(stopped.counters.skipped, 16);
  const expired = await runEvaluation({ tasks: ['ttl-lru'], deadlineMs: Date.now() - 1, provider: async () => { calls++; return valid(); } });
  assert.equal(calls, 0); assert.equal(expired.stopReason, 'global_deadline');
  const hanging = await runEvaluation({ tasks: ['ttl-lru'], modes: ['solo-codex'], callBudget: 2, globalTimeoutMs: 30, timeoutMs: 100, provider: async () => new Promise(() => {}) });
  assert.equal(hanging.counters.attempted, 1);
  assert.equal(hanging.status, 'incomplete');
  assert.ok(hanging.wallMs < 2000);
});

test('process abort distinguishes an actual launch from a prelaunch skip', async () => {
  const controller = new AbortController(); setTimeout(() => controller.abort(), 40);
  const result = await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal, timeoutMs: 1000 });
  assert.equal(result.error, 'aborted'); assert.equal(result.launched, true);
  const skipped = await runProcess(process.execPath, [], { signal: controller.signal });
  assert.equal(skipped.launched, false);
});

test('uncertainty clusters distinct tasks, excludes incomplete pairs, and labels mock drafts', () => {
  const one = taskClusterBootstrap([1]); assert.equal(one.interval95, null);
  const a = taskClusterBootstrap([1, 0, -1]), b = taskClusterBootstrap([1, 0, -1]); assert.deepEqual(a, b);
  const results = [];
  for (let t = 0; t < 3; t++) for (let trial = 0; trial < 2; trial++) for (const mode of ['collaboration', 'independent-pair']) results.push({ taskId: `t${t}`, trial, mode, executionStatus: 'complete', outcome: 'correct', grade: { correct: mode === 'collaboration' ? t !== 2 : t === 1, total: 1000, passed: 1000 }, calls: [], wallMs: 1 });
  const report = { config: { modes: ['collaboration', 'independent-pair'], providerKind: 'injected' }, results, limitations: [], runId: 'mock', startedAt: 'now' };
  const summary = summarizeEvaluation(report);
  assert.equal(summary.pairedComparisons[0].algorithmAccuracyDifference.distinctTasks, 3);
  assert.equal(summary.pairedComparisons[0].completePairs, 6);
  assert.equal(summary.pairedComparisons[0].algorithmAccuracyDifference.mean, 1 / 3);
  results[0].executionStatus = 'incomplete';
  assert.equal(summarizeEvaluation(report).pairedComparisons[0].excludedIncompletePairs, 1);
  assert.match(renderEvaluationMarkdown(report), /not independent samples/);
  assert.match(renderTwitterDraft(report), /do not present mock data/);
  assert.match(renderTwitterDraft(report), /inconclusive/);
});

test('peer first drafts run concurrently and revisions use prior-round snapshots', async () => {
  const requests = [], counts = { codex: 0, claude: 0 };
  let active = 0, maxActive = 0;
  await runTask({ task: tasks[0], mode: 'collaboration', provider: async request => {
    active++; maxActive = Math.max(maxActive, active);
    const round = ++counts[request.provider];
    requests.push(request);
    await new Promise(resolve => setTimeout(resolve, request.provider === 'codex' ? 15 : 5));
    active--;
    return { ...valid(), summary: `${request.provider}-round-${round}` };
  } });
  assert.equal(maxActive, 2);
  assert.ok(requests[2].prompt.includes('claude-round-1'));
  assert.ok(requests[3].prompt.includes('codex-round-1'));
  assert.equal(requests[3].prompt.includes('codex-round-2'), false);
});

test('selected submitter is precommitted, never chosen by hidden-test score', async () => {
  const result = await runTask({ task: tasks[0], mode: 'collaboration', finalProvider: 'claude', provider: async request => request.provider === 'codex' ? valid() : { solution: 'function solve() { return []; }', summary: 'Wrong answer.' } });
  assert.equal(result.grade.correct, false);
  assert.equal(result.final.provider, 'claude');
  assert.equal(result.usage, null);
  assert.equal(result.usageCoverage.knownCalls, 2);
});

test('failed calls remain recorded and cannot silently substitute the other peer', async () => {
  const result = await runTask({ task: tasks[0], mode: 'collaboration', provider: async request => request.provider === 'codex' ? valid() : { error: 'model_unavailable', raw: { stderr: 'test provider failure' } } });
  assert.equal(result.modelCalls, 4);
  assert.equal(result.failures.length, 2);
  assert.equal(result.final, null);
  assert.equal(result.grade.correct, false);
  assert.equal(result.calls[1].raw.stderr, 'test provider failure');
});

test('evaluation persists raw runs and only estimates cost from explicit prices', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'model-collab-eval-test-'));
  try {
    const report = await runEvaluation({ tasks: ['ttl-lru'], modes: ['solo-codex'], callBudget: 2, outputDir: directory, provider: async () => ({ ...valid(), raw: { marker: 'preserve-me' } }), prices: { codex: { inputPerMillion: 2, outputPerMillion: 5 } } });
    const artifact = JSON.parse(await readFile(report.artifactPath, 'utf8'));
    assert.equal(artifact.results.length, 1);
    assert.equal(artifact.results[0].calls[0].raw.marker, 'preserve-me');
    assert.equal(artifact.results[0].estimatedCost.kind, 'estimate_from_user_supplied_prices');
    assert.equal(artifact.results[0].estimatedCost.usd, .0006);
    assert.equal(artifact.summary[0].accuracy, 1);
    assert.equal(artifact.summary[0].modelCalls, 2);
    assert.ok(artifact.limitations.some(text => text.includes('no claim')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('process runner enforces timeout, output cap, and missing executable failure', async () => {
  const timeout = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 80 });
  assert.equal(timeout.error, 'timeout');
  const output = await runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], { maxOutputBytes: 100, timeoutMs: 1000 });
  assert.equal(output.error, 'output_limit');
  assert.ok(output.stdout.length <= 100);
  const missing = await runProcess('/no/such/model-collab-command', [], { timeoutMs: 1000 });
  assert.match(missing.error, /^spawn_error:/);
  const deadline = await runProcess(process.execPath, ['-e', 'process.exit(1)'], { deadlineMs: Date.now() - 1 });
  assert.equal(deadline.error, 'deadline_exceeded');
});

test('structured responses reject malformed or unbounded output', () => {
  assert.deepEqual(parseSolution('```json\n{"solution":"function solve() {}","summary":"ok"}\n```'), { solution: 'function solve() {}', summary: 'ok' });
  assert.throws(() => parseSolution('not json'));
  assert.throws(() => parseSolution({ solution: 'function solve() {}' }), /summary/);
  assert.throws(() => parseSolution({ solution: 'x'.repeat(100_001), summary: 'x' }), /size limit/);
});
