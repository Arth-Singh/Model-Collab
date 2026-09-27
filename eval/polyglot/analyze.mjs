// Summarizes runs/<name>/results.jsonl: pass rates with Wilson intervals, paired
// win/loss counts with exact McNemar p-values, cost, time, and collaboration
// process metrics. Usage: node analyze.mjs runs/main
import fs from 'node:fs/promises';
import path from 'node:path';

const dir = path.resolve(process.argv[2] ?? 'runs/main');
const rows = (await fs.readFile(path.join(dir, 'results.jsonl'), 'utf8'))
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const conditions = [...new Set(rows.map((r) => r.condition))];
const tasks = [...new Set(rows.map((r) => r.task))].sort();
const complete = tasks.filter((t) =>
  conditions.every((c) => rows.some((r) => r.task === t && r.condition === c)),
);
const get = (t, c) => rows.find((r) => r.task === t && r.condition === c);

function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n,
    d = 1 + (z * z) / n,
    center = (p + (z * z) / (2 * n)) / d,
    half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}
function binom(n, k) {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}
// Two-sided exact McNemar test on discordant pairs.
function mcnemar(b, c) {
  const n = b + c;
  if (!n) return 1;
  const k = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += binom(n, i);
  return Math.min(1, (2 * tail) / 2 ** n);
}
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : 0);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length
    ? s.length % 2
      ? s[(s.length - 1) / 2]
      : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
    : 0;
};
const usageOf = (r, agent, key) => r.usage?.[agent]?.[key] ?? 0;

const summary = { dir, tasks: complete.length, conditions: {}, paired: [], byLang: {} };
for (const c of conditions) {
  const rs = complete.map((t) => get(t, c));
  const k = rs.filter((r) => r.passed).length;
  summary.conditions[c] = {
    passed: k,
    n: rs.length,
    passRate: k / rs.length,
    wilson95: wilson(k, rs.length),
    meanTestFraction: mean(rs.map((r) => (r.testsTotal ? r.testsPassed / r.testsTotal : 0))),
    medianWallMin: median(rs.map((r) => r.wallMs / 60000)),
    meanWallMin: mean(rs.map((r) => r.wallMs / 60000)),
    timeouts: rs.filter((r) => r.timedOut).length,
    claudeCostUsd: sum(rs.map((r) => usageOf(r, 'claude', 'costUsd'))),
    claudeCalls: sum(rs.map((r) => usageOf(r, 'claude', 'calls'))),
    codexCalls: sum(rs.map((r) => usageOf(r, 'codex', 'calls'))),
    codexOutputTokens: sum(rs.map((r) => usageOf(r, 'codex', 'outputTokens'))),
    claudeOutputTokens: sum(rs.map((r) => usageOf(r, 'claude', 'outputTokens'))),
  };
  if (rs[0]?.process) {
    const statuses = {};
    for (const r of rs) statuses[r.process?.status] = (statuses[r.process?.status] ?? 0) + 1;
    summary.conditions[c].process = {
      statuses,
      meanMessages: mean(rs.map((r) => r.process?.messages ?? 0)),
      meanRound: mean(rs.map((r) => r.process?.round ?? 0)),
      convergedPassRate:
        rs.filter((r) => r.process?.status === 'converged' && r.passed).length /
        Math.max(1, rs.filter((r) => r.process?.status === 'converged').length),
    };
  }
  for (const lang of [...new Set(rs.map((r) => r.lang))]) {
    summary.byLang[lang] ??= {};
    const lr = rs.filter((r) => r.lang === lang);
    summary.byLang[lang][c] = `${lr.filter((r) => r.passed).length}/${lr.length}`;
  }
}
for (let i = 0; i < conditions.length; i++)
  for (let j = i + 1; j < conditions.length; j++) {
    const [a, b] = [conditions[i], conditions[j]];
    let aOnly = 0,
      bOnly = 0,
      both = 0,
      neither = 0;
    for (const t of complete) {
      const pa = get(t, a).passed,
        pb = get(t, b).passed;
      if (pa && pb) both++;
      else if (pa) aOnly++;
      else if (pb) bOnly++;
      else neither++;
    }
    summary.paired.push({ a, b, aOnly, bOnly, both, neither, mcnemarP: mcnemar(aOnly, bOnly) });
  }
// Oracle: would either solo agent have solved it? Shows the ceiling a pair could reach.
if (conditions.includes('solo-codex') && conditions.includes('solo-claude'))
  summary.eitherSoloPassed = complete.filter(
    (t) => get(t, 'solo-codex').passed || get(t, 'solo-claude').passed,
  ).length;
summary.perTask = Object.fromEntries(
  complete.map((t) => [
    t,
    Object.fromEntries(
      conditions.map((c) => {
        const r = get(t, c);
        return [c, `${r.passed ? 'PASS' : 'fail'} ${r.testsPassed}/${r.testsTotal}`];
      }),
    ),
  ]),
);
await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, perTask: undefined }, null, 2));
