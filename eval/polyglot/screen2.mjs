#!/usr/bin/env node
// Second difficulty screen. Candidates: tasks Haiku failed while passing at least one
// hidden test (interface right, logic wrong). One Sonnet 5 run each, graded on hidden
// tests. Selection rule fixed before any run:
//   1. every candidate Sonnet also fails;
//   2. if more than SIZE, stratified-by-language sample (largest remainder, mulberry32 seed 42);
//   3. if fewer than SIZE, fill with Sonnet-passed candidates in ascending order of Haiku's
//      passed-test fraction (ties by id).
// Usage: node screen2.mjs [--concurrency 8] [--select-only]
import fs from 'node:fs';
import path from 'node:path';
import {
  LANGS,
  ROOT,
  RUNS_DIR,
  copyDir,
  langOf,
  loadTask,
  mapLimit,
  mulberry32,
  readJson,
  run,
  taskDirFor,
  writeJson,
} from './common.mjs';
import { agentEnv, claudeArgs } from './agent.mjs';
import { grade } from './grade.mjs';
import { taskPrompt } from './prompt.mjs';
import { parseClaudeJson } from './usage.mjs';

const MODEL = 'claude-sonnet-5';
const EFFORT = 'medium';
const SIZE = 20;
const SEED = 42;
const DIR = path.join(RUNS_DIR, 'screen2');
const args = process.argv.slice(2);
const concurrency = Number(args[args.indexOf('--concurrency') + 1] || 8) || 8;

const haiku = readJson(path.join(ROOT, 'screen.json')).tasks;
const haikuRows = Array.isArray(haiku) ? haiku : Object.values(haiku);
const candidates = haikuRows
  .filter(
    (r) => !r.infraError && !r.passed && r.grade.outcome === 'fail' && r.grade.testsPassed > 0,
  )
  .map((r) => ({ id: r.id, haikuFraction: r.grade.testsPassed / r.grade.testsTotal }))
  .sort((a, b) => a.id.localeCompare(b.id));

async function screen({ id }) {
  const file = path.join(DIR, id, 'result.json');
  if (fs.existsSync(file)) return readJson(file);
  const taskDir = taskDirFor(id);
  const task = loadTask(taskDir);
  const ws = path.join(DIR, id, 'ws');
  fs.rmSync(path.join(DIR, id), { recursive: true, force: true });
  copyDir(path.join(taskDir, 'workspace'), ws);
  const proc = await run('claude', [...claudeArgs(MODEL), '--effort', EFFORT], {
    cwd: ws,
    env: agentEnv(ws),
    input: taskPrompt(task),
    timeoutMs: 900_000,
  });
  fs.writeFileSync(path.join(DIR, id, 'claude.stdout.json'), proc.stdout);
  const usage = parseClaudeJson(proc.stdout);
  const graded = await grade(taskDir, ws);
  const result = {
    id,
    lang: task.lang,
    passed: graded.passed,
    outcome: graded.outcome,
    testsPassed: graded.testsPassed,
    testsTotal: graded.testsTotal,
    costUsd: usage.costUsd,
    wallMs: proc.durationMs,
    infraError: !usage.ok || proc.spawnError != null,
  };
  writeJson(file, result);
  console.error(
    `${id}: ${graded.outcome} ${graded.testsPassed}/${graded.testsTotal} $${usage.costUsd?.toFixed(3)} ${Math.round(proc.durationMs / 1000)}s`,
  );
  return result;
}

const results = args.includes('--select-only')
  ? candidates.map((c) => readJson(path.join(DIR, c.id, 'result.json')))
  : await mapLimit(candidates, concurrency, screen);

const failed = results
  .filter((r) => !r.infraError && !r.passed)
  .map((r) => r.id)
  .sort();
let chosen;
if (failed.length > SIZE) {
  const byLang = Object.fromEntries(LANGS.map((l) => [l, failed.filter((id) => langOf(id) === l)]));
  const exact = LANGS.map((l) => (SIZE * byLang[l].length) / failed.length);
  const quotas = exact.map(Math.floor);
  const order = LANGS.map((l, i) => i).sort(
    (a, b) => exact[b] - quotas[b] - (exact[a] - quotas[a]) || a - b,
  );
  for (let k = 0; quotas.reduce((s, q) => s + q, 0) < SIZE; k++) quotas[order[k]]++;
  const rand = mulberry32(SEED);
  chosen = LANGS.flatMap((l, i) => {
    const ids = [...byLang[l]];
    for (let j = ids.length - 1; j > 0; j--) {
      const k = Math.floor(rand() * (j + 1));
      [ids[j], ids[k]] = [ids[k], ids[j]];
    }
    return ids.slice(0, quotas[i]);
  });
} else {
  const fill = candidates
    .filter((c) => !failed.includes(c.id) && results.find((r) => r.id === c.id && !r.infraError))
    .sort((a, b) => a.haikuFraction - b.haikuFraction || a.id.localeCompare(b.id))
    .slice(0, SIZE - failed.length)
    .map((c) => c.id);
  chosen = [...failed, ...fill];
}
writeJson(path.join(ROOT, 'screen2.json'), {
  model: MODEL,
  effort: EFFORT,
  candidates: candidates.length,
  results,
});
writeJson(path.join(ROOT, 'selection.json'), {
  rule: 'Haiku-failed tasks with >=1 hidden test passing, then Sonnet 5 (medium) failures; stratified sample of 20 (mulberry32 seed 42) if more, else filled by lowest Haiku passed-test fraction.',
  seed: SEED,
  sonnetFailed: failed,
  tasks: chosen.sort(),
});
const cost = results.reduce((s, r) => s + (r.costUsd ?? 0), 0);
console.log(
  JSON.stringify(
    {
      candidates: candidates.length,
      sonnetFailed: failed.length,
      cost: cost.toFixed(2),
      tasks: chosen,
    },
    null,
    2,
  ),
);
