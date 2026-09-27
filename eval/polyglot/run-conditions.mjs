// Runs solo and collaborative conditions on a task set and grades each final
// workspace against hidden tests. Resumable: finished jobs in results.jsonl are
// skipped. Usage:
//   node run-conditions.mjs --out runs/hard-t1 --trial 1 [--set hard|heldout]
//     [--conditions solo-codex,solo-claude,collab-new] [--tasks id1,id2]
//     [--concurrency 3] [--effort high]
// COLLAB_DIR selects the Model Collab checkout under test (default: this
// repository). Pin it to a worktree at a fixed commit so edits made during a
// run cannot change it halfway through.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { grade } from './grade.mjs';
import { taskPrompt } from './prompt.mjs';
import { agentEnv, claudeArgs } from './agent.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COLLAB_DIR = path.resolve(process.env.COLLAB_DIR ?? path.join(HERE, '..', '..'));
const SOLO_TIMEOUT_MS = 25 * 60_000;
const COLLAB_MINUTES = 25;
const COLLAB_TIMEOUT_MS = (COLLAB_MINUTES + 5) * 60_000;
// Matches the Model Collab worker: a Codex run that prints nothing for this long
// with no command in progress has lost its model stream.
const CODEX_IDLE_MS = 10 * 60_000;
// A job whose model stream stalled, or that the computer slept through, is an
// infrastructure failure, not a result. It is run again from a fresh workspace
// this many times before it is recorded.
const INFRA_RETRIES = 1;
const CONDITIONS = ['solo-codex', 'solo-claude', 'collab-new'];

const { values: opts } = parseArgs({
  options: {
    out: { type: 'string', default: 'runs/main' },
    set: { type: 'string', default: 'hard' },
    effort: { type: 'string', default: 'high' },
    concurrency: { type: 'string', default: '3' },
    conditions: { type: 'string', default: CONDITIONS.join(',') },
    tasks: { type: 'string' },
    // Repeated independent runs; the CLIs expose no sampling seed.
    trial: { type: 'string', default: '1' },
    'codex-model': { type: 'string', default: 'gpt-6-astra' },
    'claude-model': { type: 'string', default: 'claude-opus-5-5' },
  },
});
const MODELS = { codex: opts['codex-model'], claude: opts['claude-model'] };
const sets = { hard: 'selection.json', heldout: 'heldout.json' };
if (!sets[opts.set]) throw new Error(`--set must be one of: ${Object.keys(sets).join(', ')}`);
const conditions = opts.conditions.split(',');
const unknown = conditions.filter((c) => !CONDITIONS.includes(c));
if (unknown.length) throw new Error(`Unknown conditions: ${unknown.join(', ')}`);
const out = path.resolve(HERE, opts.out);
await fs.mkdir(out, { recursive: true });
const taskIds = opts.tasks
  ? opts.tasks.split(',')
  : JSON.parse(await fs.readFile(path.join(HERE, sets[opts.set]), 'utf8')).tasks;

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** True while Codex runs a command or tool call it started and has not finished. */
function codexBusy(log) {
  const open = new Set();
  for (const line of log.split('\n')) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'item.started') open.add(event.item?.id);
    else if (event.type === 'item.completed') open.delete(event.item?.id);
  }
  return open.size > 0;
}

/**
 * True when macOS logged a system sleep between the two times. A sleeping
 * machine drops the agents' model connections, so the job's result says
 * nothing about the condition. Dark wake, where a closed laptop keeps running,
 * does not count. Other platforms are assumed to stay awake.
 */
function sleptBetween(startMs, endMs) {
  if (process.platform !== 'darwin') return false;
  const log = execFileSync('pmset', ['-g', 'log'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return log.split('\n').some((line) => {
    const m = /^(\S+) (\S+) ([+-]\d\d)(\d\d) Sleep\s+Entering Sleep state/.exec(line);
    if (!m) return false;
    const at = Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`);
    return at >= startMs && at <= endMs;
  });
}

function run(command, args, { cwd, input = '', timeoutMs, idleMs, env, logFile }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '',
      stderr = '',
      timedOut = false,
      stalled = false,
      idleTimer;
    const kill = () => {
      try {
        process.kill(-child.pid, 'SIGTERM');
        setTimeout(() => {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {}
        }, 5000).unref();
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const watchIdle = () => {
      if (!idleMs) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (codexBusy(stdout)) return watchIdle();
        stalled = true;
        kill();
      }, idleMs);
    };
    watchIdle();
    child.stdout.on('data', (c) => {
      stdout += c;
      watchIdle();
    });
    child.stderr.on('data', (c) => {
      stderr += c;
      watchIdle();
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('close', async (code) => {
      clearTimeout(timer);
      clearTimeout(idleTimer);
      if (logFile)
        await fs.writeFile(logFile, JSON.stringify({ code, timedOut, stalled, stdout, stderr }));
      resolve({ code, timedOut, stalled, stdout, stderr, wallMs: Date.now() - started });
    });
  });
}

function claudeUsage(text) {
  try {
    const r = JSON.parse(text);
    return {
      costUsd: r.total_cost_usd ?? 0,
      inputTokens:
        (r.usage?.input_tokens ?? 0) +
        (r.usage?.cache_read_input_tokens ?? 0) +
        (r.usage?.cache_creation_input_tokens ?? 0),
      outputTokens: r.usage?.output_tokens ?? 0,
      isError: Boolean(r.is_error),
    };
  } catch {
    return { costUsd: 0, inputTokens: 0, outputTokens: 0, isError: true };
  }
}

function codexUsage(text) {
  let inputTokens = 0,
    outputTokens = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === 'turn.completed' && e.usage) {
        inputTokens += e.usage.input_tokens ?? 0;
        outputTokens += (e.usage.output_tokens ?? 0) + (e.usage.reasoning_output_tokens ?? 0);
      }
    } catch {}
  }
  return { costUsd: 0, inputTokens, outputTokens };
}

const add = (a, b) => ({
  costUsd: a.costUsd + b.costUsd,
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
});
const zero = { costUsd: 0, inputTokens: 0, outputTokens: 0 };

async function collabUsage(ws) {
  const usage = { codex: { ...zero, calls: 0 }, claude: { ...zero, calls: 0 } };
  for (const agent of ['codex', 'claude']) {
    const dir = path.join(ws, '.collab', 'workers', agent);
    const names = await fs.readdir(dir).catch(() => []);
    for (const name of names.filter((n) => n.endsWith('.log.json'))) {
      const log = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
      const u = agent === 'claude' ? claudeUsage(log.stdout) : codexUsage(log.stdout);
      Object.assign(usage[agent], add(usage[agent], u));
      usage[agent].calls++;
    }
  }
  return usage;
}

async function collabProcess(ws) {
  try {
    const state = JSON.parse(await fs.readFile(path.join(ws, '.collab', 'state.json'), 'utf8'));
    const s = state.session;
    return {
      status: s.status,
      stopReason: s.stopReason,
      round: s.round,
      messages: s.messages.length,
      kinds: s.messages.map((m) => `${m.agent}:${m.kind}`),
      winner: s.winner,
      checks: s.checks.length,
    };
  } catch (error) {
    return { status: 'missing', error: error.message };
  }
}

async function runCondition(condition, task, ws, dir) {
  const prompt = taskPrompt(task);
  // Full environment with the harness's offline toolchain settings; every arm gets the same one.
  const env = agentEnv(ws);
  const logFile = path.join(dir, 'agent.log.json');
  if (condition === 'solo-codex') {
    const r = await run(
      'codex',
      [
        'exec',
        '--ignore-user-config',
        // Execpolicy rules can let commands such as curl skip the sandbox.
        '--ignore-rules',
        '--ephemeral',
        '--skip-git-repo-check',
        '--sandbox',
        'workspace-write',
        '-c',
        'approval_policy="never"',
        '-c',
        `model_reasoning_effort=${JSON.stringify(opts.effort)}`,
        '-c',
        'web_search="disabled"',
        '--disable',
        'multi_agent',
        '--disable',
        'hooks',
        '--disable',
        'apps',
        '--disable',
        'plugins',
        '--model',
        MODELS.codex,
        '--cd',
        ws,
        '--json',
        '-',
      ],
      { cwd: ws, input: prompt, timeoutMs: SOLO_TIMEOUT_MS, idleMs: CODEX_IDLE_MS, env, logFile },
    );
    return {
      run: r,
      stalled: r.stalled,
      usage: { codex: { ...codexUsage(r.stdout), calls: 1 } },
    };
  }
  if (condition === 'solo-claude') {
    const r = await run('claude', [...claudeArgs(MODELS.claude), '--effort', opts.effort], {
      cwd: ws,
      input: prompt,
      timeoutMs: SOLO_TIMEOUT_MS,
      env,
      logFile,
    });
    return { run: r, stalled: false, usage: { claude: { ...claudeUsage(r.stdout), calls: 1 } } };
  }
  const r = await run(
    process.execPath,
    [
      path.join(COLLAB_DIR, 'bin', 'model-collab.js'),
      'up',
      prompt,
      '--repo',
      ws,
      '--ui',
      'workers',
      '--json',
      '--effort',
      opts.effort,
      '--minutes',
      String(COLLAB_MINUTES),
      '--turn-timeout',
      '900',
      '--codex-model',
      MODELS.codex,
      '--claude-model',
      MODELS.claude,
      // Each task is a fresh repository, so memory cannot help and would add a call.
      '--no-memory',
    ],
    { cwd: ws, timeoutMs: COLLAB_TIMEOUT_MS, env, logFile },
  );
  return {
    run: r,
    // The worker already retried the stalled turn once before giving up.
    stalled: /turn failed: stalled/.test(r.stderr),
    usage: await collabUsage(ws),
    process: await collabProcess(ws),
  };
}

function gitHead(dir) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: dir,
    encoding: 'utf8',
  }).trim();
  return dirty ? `${head}+dirty` : head;
}

const resultsFile = path.join(out, 'results.jsonl');
const done = new Set(
  (await fs.readFile(resultsFile, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const r = JSON.parse(line);
      return `${r.task}|${r.condition}`;
    }),
);

const rand = mulberry32(42);
const jobs = taskIds
  .flatMap((task) => conditions.map((condition) => ({ task, condition })))
  .filter((j) => !done.has(`${j.task}|${j.condition}`))
  .map((j) => ({ ...j, key: rand() }))
  .sort((a, b) => a.key - b.key);

await fs.writeFile(
  path.join(out, `manifest-${conditions.join('+')}.json`),
  JSON.stringify(
    {
      startedAt: new Date().toISOString(),
      models: MODELS,
      effort: opts.effort,
      trial: Number(opts.trial),
      set: opts.tasks ? 'custom' : opts.set,
      conditions,
      tasks: taskIds,
      soloTimeoutMs: SOLO_TIMEOUT_MS,
      collabMinutes: COLLAB_MINUTES,
      codexIdleMs: CODEX_IDLE_MS,
      collabCommit: gitHead(COLLAB_DIR),
      harnessCommit: gitHead(HERE),
    },
    null,
    2,
  ),
);

async function attempt(job, task, taskDir) {
  const dir = path.join(out, job.task, job.condition);
  const ws = path.join(dir, 'ws');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.cp(path.join(taskDir, 'workspace'), ws, { recursive: true });
  await fs.appendFile(path.join(ws, '.git', 'info', 'exclude'), '\n.collab/\n');
  const started = Date.now();
  let outcome;
  try {
    outcome = await runCondition(job.condition, task, ws, dir);
  } catch (error) {
    outcome = { run: { code: null, error: error.message, wallMs: 0 }, stalled: false, usage: {} };
  }
  const startedAt = new Date(started).toISOString();
  return { startedAt, dir, ws, ...outcome, slept: sleptBetween(started, Date.now()) };
}

let next = 0,
  finished = 0;
async function workerLoop() {
  while (next < jobs.length) {
    const job = jobs[next++];
    const taskDir = path.join(HERE, 'tasks', job.task);
    const task = JSON.parse(await fs.readFile(path.join(taskDir, 'task.json'), 'utf8'));
    let outcome,
      retries = 0;
    for (;;) {
      outcome = await attempt(job, task, taskDir);
      const infra = outcome.slept ? 'the computer slept' : outcome.stalled ? 'stalled' : null;
      if (!infra || retries >= INFRA_RETRIES) break;
      retries++;
      console.log(`${job.task} ${job.condition}: ${infra}; running it again`);
    }
    const graded = await grade(taskDir, outcome.ws);
    const record = {
      task: job.task,
      trial: Number(opts.trial),
      lang: task.lang,
      condition: job.condition,
      startedAt: outcome.startedAt,
      wallMs: outcome.run.wallMs,
      exitCode: outcome.run.code,
      timedOut: outcome.run.timedOut ?? false,
      // Attempts discarded as infrastructure failures. `stalled` or `slept` on
      // the final attempt marks the record itself as one.
      infraRetries: retries,
      stalled: outcome.stalled,
      slept: outcome.slept,
      passed: graded.passed,
      testsPassed: graded.testsPassed,
      testsTotal: graded.testsTotal,
      gradeOutcome: graded.outcome,
      usage: outcome.usage,
      process: outcome.process ?? null,
    };
    await fs.writeFile(path.join(outcome.dir, 'grade.json'), JSON.stringify(graded, null, 2));
    await fs.appendFile(resultsFile, JSON.stringify(record) + '\n');
    finished++;
    console.log(
      `[${finished}/${jobs.length}] ${job.task} ${job.condition} passed=${graded.passed} ${graded.testsPassed}/${graded.testsTotal} ${Math.round(outcome.run.wallMs / 1000)}s${outcome.stalled ? ' STALLED' : ''}${outcome.slept ? ' SLEPT' : ''}`,
    );
  }
}
await Promise.all(Array.from({ length: Number(opts.concurrency) }, workerLoop));
console.log('ALL DONE');
