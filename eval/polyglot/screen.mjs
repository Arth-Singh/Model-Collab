#!/usr/bin/env node
// Difficulty screen: one Haiku run per eligible task, graded on hidden tests; then deterministic subset selection.
// Usage: node screen.mjs [--only id,id | --per-lang N] [--concurrency 8] [--force] [--out screen.json] [--select-only] [--no-select]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  LANGS,
  ROOT,
  RUNS_DIR,
  copyDir,
  filterIds,
  langOf,
  loadTask,
  mapLimit,
  mulberry32,
  parseArgs,
  readJson,
  run,
  taskDirFor,
  writeJson,
} from './common.mjs';
import { agentEnv, claudeArgs } from './agent.mjs';
import { grade } from './grade.mjs';
import { taskPrompt } from './prompt.mjs';
import { parseClaudeJson } from './usage.mjs';

export const SCREEN_MODEL = 'claude-haiku-4-5-20251001';
const AGENT_TIMEOUT_MS = 600_000;
const SCREEN_DIR = path.join(RUNS_DIR, 'screen');
const SELECTION_SIZE = 30;
const SELECTION_SEED = 42;
const INFRA_RETRIES = 1;

/** An agent run that never produced a usable result (auth, rate limit, crash) is infrastructure, not a task failure. */
function isInfraError(proc, usage) {
  if (proc.spawnError) return true;
  if (proc.timedOut) return false;
  if (!usage.ok) return true;
  return usage.isError === true && (usage.numTurns ?? 0) <= 1;
}

async function screenTask(id, { force }) {
  const taskDir = taskDirFor(id);
  const task = loadTask(taskDir);
  const runDir = path.join(SCREEN_DIR, id);
  const resultFile = path.join(runDir, 'result.json');
  if (!force && fs.existsSync(resultFile)) {
    const cached = readJson(resultFile);
    if (!cached.infraError) return cached;
  }

  let attempt = 0;
  for (;;) {
    fs.rmSync(runDir, { recursive: true, force: true });
    const ws = path.join(runDir, 'ws');
    copyDir(path.join(taskDir, 'workspace'), ws);
    const proc = await run('claude', claudeArgs(SCREEN_MODEL), {
      cwd: ws,
      env: agentEnv(ws),
      input: taskPrompt(task),
      timeoutMs: AGENT_TIMEOUT_MS,
    });
    fs.writeFileSync(path.join(runDir, 'claude.stdout.json'), proc.stdout);
    fs.writeFileSync(path.join(runDir, 'claude.stderr.txt'), proc.stderr);
    const usage = parseClaudeJson(proc.stdout);
    const infraError = isInfraError(proc, usage);
    if (infraError && attempt < INFRA_RETRIES) {
      attempt++;
      console.error(
        `${id}: infra error (exit ${proc.code}), retrying: ${(usage.result ?? proc.stderr).slice(0, 300)}`,
      );
      continue;
    }
    const graded = await grade(taskDir, ws);
    const result = {
      id,
      lang: task.lang,
      model: SCREEN_MODEL,
      attempts: attempt + 1,
      infraError,
      agent: {
        exitCode: proc.code,
        timedOut: proc.timedOut,
        wallMs: proc.durationMs,
        costUsd: usage.costUsd,
        durationMs: usage.durationMs,
        numTurns: usage.numTurns,
        isError: usage.isError,
        subtype: usage.subtype,
        usage: usage.usage,
      },
      grade: graded,
      passed: graded.passed,
    };
    writeJson(resultFile, result);
    console.error(
      `${id}: ${graded.outcome} ${graded.testsPassed}/${graded.testsTotal} cost=$${usage.costUsd?.toFixed(4) ?? '?'} turns=${usage.numTurns ?? '?'} ${Math.round(proc.durationMs / 1000)}s${infraError ? ' INFRA_ERROR' : ''}`,
    );
    return result;
  }
}

function summarize(results) {
  const byLang = {};
  for (const lang of LANGS) {
    const rows = results.filter((r) => r.lang === lang && !r.infraError);
    const passed = rows.filter((r) => r.passed).length;
    byLang[lang] = {
      screened: rows.length,
      passed,
      failed: rows.length - passed,
      passRate: rows.length ? passed / rows.length : null,
    };
  }
  const valid = results.filter((r) => !r.infraError);
  return {
    screened: valid.length,
    passed: valid.filter((r) => r.passed).length,
    passRate: valid.length ? valid.filter((r) => r.passed).length / valid.length : null,
    infraErrors: results.filter((r) => r.infraError).map((r) => r.id),
    totalCostUsd: Number(results.reduce((sum, r) => sum + (r.agent.costUsd ?? 0), 0).toFixed(6)),
    byLang,
  };
}

/**
 * Deterministic selection: every task Haiku failed. If more than SELECTION_SIZE, a stratified-by-language sample:
 * per-language quotas by largest remainder (ties broken by LANGS order), then within each language (ids sorted)
 * a Fisher-Yates shuffle driven by one mulberry32(SELECTION_SEED) stream consumed in LANGS order; take the first quota ids.
 */
export function selectTasks(results) {
  const failed = results
    .filter((r) => !r.infraError && !r.passed)
    .map((r) => r.id)
    .sort();
  const rule =
    `All eligible tasks that ${SCREEN_MODEL} failed on hidden tests in a single screening run. ` +
    `If more than ${SELECTION_SIZE}: stratified by language with largest-remainder quotas (ties by order ${LANGS.join(',')}), ` +
    `within-language Fisher-Yates shuffle of sorted ids using mulberry32(seed=${SELECTION_SEED}) consumed in language order, first <quota> ids taken.`;
  const failedByLang = Object.fromEntries(
    LANGS.map((l) => [l, failed.filter((id) => langOf(id) === l)]),
  );
  if (failed.length <= SELECTION_SIZE) {
    return {
      rule,
      seed: SELECTION_SEED,
      sampled: false,
      failedCount: failed.length,
      failedByLang,
      quotas: null,
      taskIds: failed,
    };
  }
  const exact = LANGS.map((l) => (SELECTION_SIZE * failedByLang[l].length) / failed.length);
  const quotas = exact.map(Math.floor);
  const order = LANGS.map((_, i) => i).sort(
    (a, b) => exact[b] - quotas[b] - (exact[a] - quotas[a]) || a - b,
  );
  for (let k = 0, left = SELECTION_SIZE - quotas.reduce((s, q) => s + q, 0); k < left; k++)
    quotas[order[k]]++;
  const rand = mulberry32(SELECTION_SEED);
  const taskIds = [];
  LANGS.forEach((lang, i) => {
    const ids = [...failedByLang[lang]];
    for (let j = ids.length - 1; j > 0; j--) {
      const r = Math.floor(rand() * (j + 1));
      [ids[j], ids[r]] = [ids[r], ids[j]];
    }
    taskIds.push(...ids.slice(0, quotas[i]).sort());
  });
  return {
    rule,
    seed: SELECTION_SEED,
    sampled: true,
    failedCount: failed.length,
    failedByLang,
    quotas: Object.fromEntries(LANGS.map((l, i) => [l, quotas[i]])),
    taskIds,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outFile = path.join(ROOT, opts.out ?? 'screen.json');
  let results;
  if (opts['select-only']) {
    results = Object.values(readJson(outFile).tasks);
  } else {
    const preflight = readJson(path.join(ROOT, 'preflight.json'));
    const ids = filterIds(preflight.eligible, opts);
    const concurrency = Number(opts.concurrency ?? 8);
    console.error(`Screening ${ids.length} tasks with ${SCREEN_MODEL}, concurrency ${concurrency}`);
    results = await mapLimit(ids, concurrency, (id) =>
      screenTask(id, { force: Boolean(opts.force) }),
    );
    const summary = summarize(results);
    writeJson(outFile, {
      generatedAt: new Date().toISOString(),
      model: SCREEN_MODEL,
      prompt: 'prompt.mjs taskPrompt(task)',
      agentTimeoutMs: AGENT_TIMEOUT_MS,
      scope: opts.only || opts['per-lang'] ? 'partial' : 'full',
      summary,
      tasks: Object.fromEntries(results.map((r) => [r.id, r])),
    });
    console.log(JSON.stringify(summary, null, 2));
    if (opts['no-select']) return;
  }
  const summary = summarize(results);
  if (summary.infraErrors.length) {
    throw new Error(
      `Refusing to select: infra errors on ${summary.infraErrors.join(', ')}. Re-run screen.mjs to retry them.`,
    );
  }
  const selection = selectTasks(results);
  writeJson(path.join(ROOT, opts['selection-out'] ?? 'screen-selection.json'), {
    generatedAt: new Date().toISOString(),
    screenModel: SCREEN_MODEL,
    screenFile: path.basename(outFile),
    ...selection,
  });
  console.log(
    JSON.stringify(
      { selected: selection.taskIds.length, quotas: selection.quotas, taskIds: selection.taskIds },
      null,
      2,
    ),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack ?? String(error));
    process.exit(1);
  });
}
