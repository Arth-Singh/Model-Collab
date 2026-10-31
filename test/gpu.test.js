import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { GpuJobs, jobCommand } from '../src/gpu.js';
import { gpuSchema } from '../src/schema.js';
import { Store } from '../src/store.js';
import { captureBase, createOrigin, originHead } from '../src/workspace.js';
import { gitProject } from './helpers.js';

// A launcher stand-in: records its arguments, writes an output file, and runs
// for as long as its first agent argument says.
const LAUNCHER = `#!/bin/sh
out=$1; gpus=$2; seconds=$3; shift 3
mkdir -p "$out"
printf '%s\\n' "gpus=$gpus" "seconds=$seconds" > "$out/launch.txt"
for a in "$@"; do printf '[%s]\\n' "$a" >> "$out/args.txt"; done
while [ "$1" != "--" ]; do shift; done; shift
[ -n "$1" ] && sleep "$1"
echo "trained" > "$out/summary.json"
exit 0
`;

async function setup(t, overrides = {}) {
  const root = await gitProject(t, 'model-collab-gpu-', {
    'launch.sh': LAUNCHER,
    'README.md': 'x\n',
  });
  const remote = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'model-collab-host-')));
  t.after(() => fs.rm(remote, { recursive: true, force: true }));
  await fs.mkdir(path.join(remote, 'datasets', 'stream-1'), { recursive: true });
  await fs.writeFile(path.join(remote, 'datasets', 'stream-1', 'train.txt'), 'hello\n');
  const store = new Store(root);
  const base = await captureBase(root, path.join(store.dir, 'tmp'));
  const origin = await createOrigin(base, path.join(store.runDir, 'origin.git'));
  const gpu = gpuSchema.parse({
    host: 'local',
    dir: path.join(remote, 'jobs'),
    gpus: [6, 7],
    maxMinutes: 30,
    prepare: 'mkdir -p prepared && echo ok > prepared/flag',
    command: [
      'sh',
      'launch.sh',
      'results/{job}',
      '{gpus}',
      '{seconds}',
      '{dataset}',
      '--',
      '{args}',
    ],
    datasetFlag: '--dataset',
    datasetSource: path.join(remote, 'datasets'),
    ...overrides,
  });
  const run = { id: 'abcdef12-run', origin };
  return { root, remote, store, origin, gpu, jobs: (now) => new GpuJobs({ store, run, gpu, now }) };
}

async function deadPid() {
  const child = spawn('true');
  await new Promise((resolve) => child.on('exit', resolve));
  return child.pid;
}

async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value || Date.now() > end) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('agent arguments fill only the {args} slot of the command', () => {
  const gpu = gpuSchema.parse({
    host: 'local',
    dir: '/x',
    gpus: [0],
    command: ['run', '--out', 'results/{job}', '--gpus', '{gpus}', '{dataset}', '--', '{args}'],
    datasetFlag: '--dataset',
  });
  assert.deepEqual(
    jobCommand(gpu, {
      job: 'j1-codex-1',
      gpus: [3, 4],
      seconds: 60,
      dataset: 'd1',
      args: ['-m', 'x'],
    }),
    [
      'run',
      '--out',
      'results/j1-codex-1',
      '--gpus',
      '3,4',
      '--dataset',
      'data/d1',
      '--',
      '-m',
      'x',
    ],
  );
  assert.deepEqual(jobCommand(gpu, { job: 'j2-a', gpus: [0], seconds: 1, args: [] }), [
    'run',
    '--out',
    'results/j2-a',
    '--gpus',
    '0',
    '--',
  ]);
  assert.throws(() => gpuSchema.parse({ ...gpu, command: ['run'] }), /exactly one \{args\} slot/);
});

test('a job runs a pushed commit on reserved GPUs and its files can be read', async (t) => {
  const { origin, remote, jobs } = await setup(t);
  const gpu = jobs();
  const commit = await originHead(origin);
  const started = await gpu.start({
    agent: 'claude-1',
    commit,
    gpus: 1,
    minutes: 5,
    dataset: 'stream-1',
    args: ['0', 'it has spaces', "quote's", '$HOME;rm -rf /'],
  });
  assert.equal(started.id, 'j1-claude-1');
  assert.equal(started.launcher, process.pid);
  assert.deepEqual(started.gpus, [6]);
  const done = await until(async () => {
    const status = await gpu.status('j1-claude-1');
    return status.state === 'finished' && status;
  });
  assert.equal(done.exitCode, 0);
  const tree = path.join(remote, 'jobs', 'abcdef12', 'j1-claude-1');
  assert.equal((await fs.readFile(path.join(tree, 'COMMIT'), 'utf8')).trim(), commit);
  assert.equal(await fs.readFile(path.join(tree, 'prepared', 'flag'), 'utf8'), 'ok\n');
  assert.equal(
    await fs.readFile(path.join(tree, 'data', 'stream-1', 'train.txt'), 'utf8'),
    'hello\n',
  );
  assert.equal(
    await gpu.read('j1-claude-1', 'results/j1-claude-1/args.txt'),
    "[--dataset]\n[data/stream-1]\n[--]\n[0]\n[it has spaces]\n[quote's]\n[$HOME;rm -rf /]\n",
  );
  assert.match(
    await gpu.read('j1-claude-1', 'results/j1-claude-1/launch.txt'),
    /gpus=6\nseconds=300/,
  );
  assert.match(await gpu.read('j1-claude-1', 'results/j1-claude-1'), /summary\.json/);
  await assert.rejects(gpu.read('j1-claude-1', '../../etc/passwd'), /inside the job directory/);
});

test('GPUs are never shared; finished jobs free theirs, cancelled ones keep them until their limit', async (t) => {
  const { origin, jobs } = await setup(t);
  let clock = Date.now();
  const gpu = jobs(() => clock);
  const commit = await originHead(origin);
  const long = await gpu.start({ agent: 'codex-1', commit, gpus: 1, minutes: 5, args: ['30'] });
  const short = await gpu.start({ agent: 'claude-2', commit, gpus: 1, minutes: 5, args: ['0'] });
  assert.deepEqual([long.gpus, short.gpus], [[6], [7]]);
  await assert.rejects(
    gpu.start({ agent: 'claude-3', commit, gpus: 1, args: [] }),
    /Only 0 of 2 GPUs are free/,
  );
  await until(async () => (await gpu.status(short.id)).state === 'finished');
  assert.deepEqual((await gpu.list()).free, [7]);
  const cancelled = await gpu.cancel(long.id);
  assert.equal(cancelled.state, 'cancelled');
  assert.deepEqual((await gpu.list()).free, [7], 'a cancelled job keeps its GPU');
  clock += 30 * 60_000;
  assert.deepEqual((await gpu.list()).free, [6, 7]);
  await assert.rejects(gpu.cancel(short.id), /is finished, not running/);
});

test('jobs are capped at the configured time limit and refuse bad input', async (t) => {
  const { origin, jobs } = await setup(t, { maxMinutes: 2 });
  const gpu = jobs();
  const commit = await originHead(origin);
  const job = await gpu.start({ agent: 'claude-1', commit, minutes: 600, args: ['0'] });
  assert.equal(job.minutes, 2);
  await assert.rejects(
    gpu.start({ agent: 'claude-1', commit, gpus: 3, args: [] }),
    /GPUs are free/,
  );
  await assert.rejects(
    gpu.start({ agent: 'claude-1', commit, dataset: '../secrets', args: [] }),
    /Invalid dataset name/,
  );
  await assert.rejects(
    gpu.start({ agent: 'claude-1', commit: 'f'.repeat(40), args: [] }),
    /Copying the code/,
  );
  const failed = (await gpu.jobs()).find((j) => j.commit === 'f'.repeat(40));
  assert.equal(failed.state, 'failed_to_start');
});

test('a failed prepare step or a missing dataset launches nothing', async (t) => {
  const { origin, remote, jobs } = await setup(t, { prepare: 'false' });
  const gpu = jobs();
  const commit = await originHead(origin);
  await assert.rejects(
    gpu.start({ agent: 'codex-2', commit, args: ['0'] }),
    /Starting the job failed/,
  );
  const tree = path.join(remote, 'jobs', 'abcdef12', 'j1-codex-2');
  await assert.rejects(fs.access(path.join(tree, 'job.log')));
  assert.deepEqual((await gpu.list()).free, [6, 7]);
  const missing = await setup(t);
  await assert.rejects(
    missing.jobs().start({
      agent: 'codex-2',
      commit: await originHead(missing.origin),
      dataset: 'no-such-dataset',
      args: ['0'],
    }),
    /Starting the job failed/,
  );
});

test('an abandoned launch frees its GPUs unless it reached the host', async (t) => {
  const { origin, remote, store, jobs } = await setup(t);
  const commit = await originHead(origin);
  const launcher = await deadPid();
  const now = Date.now();
  const record = (id, gpus) => ({
    id,
    agent: 'codex-1',
    commit,
    gpus,
    minutes: 5,
    dataset: null,
    args: [],
    state: 'starting',
    startedAt: new Date(now - 60_000).toISOString(),
    deadlineAt: new Date(now + 15 * 60_000).toISOString(),
    tree: path.join(remote, 'jobs', 'abcdef12', id),
    launcher,
    pid: null,
    exitCode: null,
    error: null,
  });
  // j1 never reached the host; j2 had started writing its log when its MCP server exited.
  const records = [record('j1-codex-1', [6]), record('j2-codex-1', [7])];
  await fs.mkdir(records[1].tree, { recursive: true });
  await fs.writeFile(path.join(records[1].tree, 'job.log'), '');
  await fs.writeFile(path.join(store.runDir, 'gpu-jobs.json'), JSON.stringify(records));
  const listed = await jobs().list();
  assert.deepEqual(
    listed.jobs.map((j) => j.state),
    ['failed_to_start', 'lost'],
  );
  assert.deepEqual(listed.free, [6], 'a launch that reached the host keeps its GPU');
});

test('a host restart frees the GPUs of every job that started before it', async (t) => {
  const { origin, remote, store, jobs } = await setup(t);
  const commit = await originHead(origin);
  const tree = path.join(remote, 'jobs', 'abcdef12', 'j1-claude-1');
  await fs.mkdir(tree, { recursive: true });
  const job = {
    id: 'j1-claude-1',
    agent: 'claude-1',
    commit,
    gpus: [6, 7],
    minutes: 5,
    dataset: null,
    args: [],
    state: 'running',
    // Before this machine's (the "local" host's) last boot.
    startedAt: new Date(1_000).toISOString(),
    deadlineAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    tree,
    launcher: process.pid,
    pid: await deadPid(),
    exitCode: null,
    error: null,
  };
  await fs.writeFile(path.join(store.runDir, 'gpu-jobs.json'), JSON.stringify([job]));
  const listed = await jobs().list();
  assert.equal(listed.jobs[0].state, 'lost');
  assert.equal(listed.jobs[0].hostRestarted, true);
  assert.deepEqual(listed.free, [6, 7]);
});
