// Aggregates repeated trials of the same conditions: per-trial pass rates,
// mean and sample SD across trials, per-task pass counts, flip rate, cost, and
// time. Each argument is one trial's run directory.
// Usage: node variance.mjs runs/main runs/solo-t2 runs/solo-t3
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirs = process.argv.slice(2);
if (dirs.length < 2) {
  console.error('Usage: node variance.mjs <trial-dir> <trial-dir> [...]');
  process.exit(1);
}

const trials = [];
for (const dir of dirs) {
  const rows = (await fs.readFile(path.join(path.resolve(dir), 'results.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  trials.push({ dir, rows });
}

const conditions = [...new Set(trials.flatMap((t) => t.rows.map((r) => r.condition)))];
const tasks = [...new Set(trials.flatMap((t) => t.rows.map((r) => r.task)))].sort();
const get = (trial, task, condition) =>
  trial.rows.find((r) => r.task === task && r.condition === condition);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs) =>
  xs.length < 2 ? 0 : Math.sqrt(xs.reduce((a, x) => a + (x - mean(xs)) ** 2, 0) / (xs.length - 1));
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const cost = (r) => Object.values(r.usage ?? {}).reduce((sum, u) => sum + (u?.costUsd ?? 0), 0);

const missing = [];
for (const trial of trials)
  for (const task of tasks)
    for (const condition of conditions)
      if (!get(trial, task, condition)) missing.push(`${trial.dir}: ${task} ${condition}`);
if (missing.length) {
  console.log(`Incomplete: ${missing.length} missing results`);
  for (const m of missing.slice(0, 20)) console.log(`  ${m}`);
  console.log('Only tasks present in every trial for a condition are counted.\n');
}

const summary = {};
for (const condition of conditions) {
  const counted = tasks.filter((task) => trials.every((t) => get(t, task, condition)));
  const perTrial = trials.map((t) => {
    const rows = counted.map((task) => get(t, task, condition));
    return {
      dir: t.dir,
      passRate: mean(rows.map((r) => (r.passed ? 1 : 0))),
      testFraction: mean(rows.map((r) => (r.testsTotal ? r.testsPassed / r.testsTotal : 0))),
      cost: rows.reduce((a, r) => a + cost(r), 0),
      minutes: mean(rows.map((r) => r.wallMs / 60000)),
      infra: rows.filter(
        (r) => r.stalled || r.timedOut || Object.values(r.usage ?? {}).some((u) => u?.isError),
      ).length,
    };
  });
  const perTask = counted.map((task) => {
    const passes = trials.filter((t) => get(t, task, condition).passed).length;
    return { task, passes };
  });
  const flips = perTask.filter((x) => x.passes > 0 && x.passes < trials.length).length;
  const rates = perTrial.map((x) => x.passRate);
  summary[condition] = {
    tasks: counted.length,
    trials: trials.length,
    passRateMean: mean(rates),
    passRateSD: sd(rates),
    passRates: rates,
    testFractionMean: mean(perTrial.map((x) => x.testFraction)),
    alwaysPass: perTask.filter((x) => x.passes === trials.length).length,
    neverPass: perTask.filter((x) => x.passes === 0).length,
    flips,
    // Share of tasks solved in at least one trial: the ceiling a perfect selector could reach.
    anyPass: perTask.filter((x) => x.passes > 0).length / counted.length,
    costPerTrial: mean(perTrial.map((x) => x.cost)),
    minutesPerTask: mean(perTrial.map((x) => x.minutes)),
    infraFailures: perTrial.reduce((a, x) => a + x.infra, 0),
    perTask,
  };
}

for (const [condition, s] of Object.entries(summary)) {
  console.log(`${condition}  (${s.tasks} tasks x ${s.trials} trials)`);
  console.log(
    `  pass rate      ${pct(s.passRateMean)} ± ${pct(s.passRateSD)} SD   per trial: ${s.passRates.map(pct).join(', ')}`,
  );
  console.log(`  tests passed   ${pct(s.testFractionMean)} of hidden tests on average`);
  console.log(
    `  per task       always ${s.alwaysPass}, never ${s.neverPass}, flipped ${s.flips} (${pct(s.flips / s.tasks)})`,
  );
  console.log(`  any-trial pass ${pct(s.anyPass)}`);
  console.log(
    `  cost/time      $${s.costPerTrial.toFixed(2)} per trial, ${s.minutesPerTask.toFixed(1)} min per task`,
  );
  if (s.infraFailures)
    console.log(`  infra failures ${s.infraFailures} (stalls, timeouts, or client errors)`);
  console.log();
}

// Exact two-sided McNemar test on discordant (task, trial) pairs pooled over trials.
function mcnemar(b, c) {
  const n = b + c;
  if (!n) return 1;
  let tail = 0,
    term = 1;
  for (let i = 0; i <= Math.min(b, c); i++) {
    tail += term;
    term = (term * (n - i)) / (i + 1);
  }
  return Math.min(1, (2 * tail) / 2 ** n);
}
const paired = [];
for (let i = 0; i < conditions.length; i++)
  for (let j = i + 1; j < conditions.length; j++) {
    const [a, b] = [conditions[i], conditions[j]];
    let aOnly = 0,
      bOnly = 0,
      pairs = 0;
    for (const trial of trials)
      for (const task of tasks) {
        const ra = get(trial, task, a),
          rb = get(trial, task, b);
        if (!ra || !rb) continue;
        pairs++;
        if (ra.passed && !rb.passed) aOnly++;
        if (rb.passed && !ra.passed) bOnly++;
      }
    paired.push({ a, b, pairs, aOnly, bOnly, mcnemarP: mcnemar(aOnly, bOnly) });
  }
console.log('Paired over all trials');
for (const x of paired)
  console.log(
    `  ${x.a} vs ${x.b}: ${x.pairs} pairs, only ${x.a} passed ${x.aOnly}, only ${x.b} passed ${x.bOnly}, McNemar p = ${x.mcnemarP.toFixed(4)}`,
  );
// Best of the two solo answers in the same trial: what a perfect chooser could reach.
let bestOfSolo = null;
if (conditions.includes('solo-codex') && conditions.includes('solo-claude')) {
  const rates = trials.map((trial) => {
    const both = tasks.filter(
      (task) => get(trial, task, 'solo-codex') && get(trial, task, 'solo-claude'),
    );
    return (
      both.filter(
        (task) => get(trial, task, 'solo-codex').passed || get(trial, task, 'solo-claude').passed,
      ).length / both.length
    );
  });
  bestOfSolo = { mean: mean(rates), sd: sd(rates), perTrial: rates };
  console.log(`  best of both solo answers: ${pct(bestOfSolo.mean)} ± ${pct(bestOfSolo.sd)} SD`);
}
console.log();

console.log('Per-task passes out of', trials.length);
const width = Math.max(...tasks.map((t) => t.length));
console.log(`${''.padEnd(width)}  ${conditions.map((c) => c.padStart(12)).join('')}`);
for (const task of tasks)
  console.log(
    `${task.padEnd(width)}  ${conditions
      .map((c) => {
        const x = summary[c].perTask.find((p) => p.task === task);
        return (x ? String(x.passes) : '-').padStart(12);
      })
      .join('')}`,
  );

await fs.writeFile(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'runs',
    `variance-${conditions.join('+')}.json`,
  ),
  JSON.stringify({ dirs, summary, paired, bestOfSolo }, null, 2) + '\n',
);
