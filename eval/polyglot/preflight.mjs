#!/usr/bin/env node
// Prefetch cargo deps, then verify per task: reference passes hidden tests, untouched stub fails.
// Usage: node preflight.mjs [--only id,id | --per-lang N] [--concurrency 4] [--skip-fetch]
import fs from 'node:fs';
import path from 'node:path';
import {
  LANGS,
  ROOT,
  RUNS_DIR,
  copyDir,
  copyFile,
  filterIds,
  langOf,
  listTaskIds,
  loadTask,
  mapLimit,
  parseArgs,
  readJson,
  run,
  taskDirFor,
  writeJson,
} from './common.mjs';
import { grade } from './grade.mjs';

const PREFLIGHT_TMP = path.join(RUNS_DIR, '.preflight');

function materializeReference(taskDir, task) {
  const dest = path.join(PREFLIGHT_TMP, task.id, 'reference-ws');
  fs.rmSync(dest, { recursive: true, force: true });
  copyDir(path.join(taskDir, 'workspace'), dest, { exclude: (rel) => rel === '.git' });
  for (const rel of task.referenceFiles)
    copyFile(path.join(taskDir, 'reference', rel), path.join(dest, rel));
  return dest;
}

async function cargoFetch(ids) {
  const failures = [];
  await mapLimit(ids, 4, async (id) => {
    const taskDir = taskDirFor(id);
    const task = loadTask(taskDir);
    const variants = {
      stub: path.join(taskDir, 'workspace'),
      reference: materializeReference(taskDir, task),
    };
    for (const [variant, src] of Object.entries(variants)) {
      const dir = path.join(PREFLIGHT_TMP, id, `fetch-${variant}`);
      fs.rmSync(dir, { recursive: true, force: true });
      copyDir(src, dir, { exclude: (rel) => rel === '.git' });
      for (const rel of task.testFiles)
        copyFile(path.join(taskDir, 'hidden', rel), path.join(dir, rel));
      const result = await run('cargo', ['fetch'], { cwd: dir, timeoutMs: 300_000 });
      if (result.code !== 0) failures.push({ id, variant, stderr: result.stderr.slice(-2000) });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  return failures;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const ids = filterIds(listTaskIds(), opts);
  const concurrency = Number(opts.concurrency ?? 4);
  const manifest = readJson(path.join(ROOT, 'manifest.json'));
  fs.mkdirSync(PREFLIGHT_TMP, { recursive: true });

  const rustIds = ids.filter((id) => langOf(id) === 'rust');
  let fetchFailures = [];
  if (!opts['skip-fetch'] && rustIds.length) {
    console.error(`cargo fetch for ${rustIds.length} rust tasks (network)...`);
    fetchFailures = await cargoFetch(rustIds);
    if (fetchFailures.length)
      console.error(`cargo fetch failures: ${JSON.stringify(fetchFailures, null, 2)}`);
  }

  const results = {};
  await mapLimit(ids, concurrency, async (id) => {
    const taskDir = taskDirFor(id);
    const task = loadTask(taskDir);
    const reference = await grade(taskDir, materializeReference(taskDir, task));
    const stub = await grade(taskDir, path.join(taskDir, 'workspace'));
    const reasons = [];
    if (!reference.passed)
      reasons.push(
        `reference solution fails hidden tests (${reference.outcome}, ${reference.testsPassed}/${reference.testsTotal})`,
      );
    if (stub.passed)
      reasons.push(`untouched stub passes hidden tests (${stub.testsPassed}/${stub.testsTotal})`);
    results[id] = { eligible: reasons.length === 0, reasons, reference, stub };
    console.error(
      `${id}: ref=${reference.outcome} ${reference.testsPassed}/${reference.testsTotal} stub=${stub.outcome} ${stub.testsPassed}/${stub.testsTotal}${reasons.length ? ` EXCLUDED: ${reasons.join('; ')}` : ''}`,
    );
    fs.rmSync(path.join(PREFLIGHT_TMP, id), { recursive: true, force: true });
  });

  const ordered = Object.fromEntries(ids.map((id) => [id, results[id]]));
  const eligible = ids.filter((id) => results[id].eligible);
  const excluded = [
    ...manifest.skipped.map((s) => ({ id: s.id, stage: 'prepare', reason: s.reason })),
    ...ids
      .filter((id) => !results[id].eligible)
      .map((id) => ({ id, stage: 'preflight', reason: results[id].reasons.join('; ') })),
  ];
  const eligibleByLang = Object.fromEntries(
    LANGS.map((l) => [l, eligible.filter((id) => langOf(id) === l).length]),
  );
  writeJson(path.join(ROOT, opts.out ?? 'preflight.json'), {
    generatedAt: new Date().toISOString(),
    benchmarkCommit: manifest.benchmark.commit,
    scope: opts.only || opts['per-lang'] ? 'partial' : 'full',
    cargoFetchFailures: fetchFailures,
    eligibleByLang,
    eligibleCount: eligible.length,
    eligible,
    excluded,
    results: ordered,
  });
  console.log(
    JSON.stringify({ eligibleByLang, eligibleCount: eligible.length, excluded }, null, 2),
  );
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exit(1);
});
