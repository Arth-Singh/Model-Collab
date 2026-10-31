import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import lockfile from 'proper-lockfile';
import { alive, atomicWrite } from './store.js';

// GPU jobs for agents. Agents have no network, so they cannot reach a GPU host
// themselves. Their MCP server, which runs outside the sandbox, starts a job
// for them: it copies a pushed commit to a fresh directory on the host, runs
// the user's prepare step there, and launches the user's command template with
// the agent's arguments in the slot the template leaves for them. Agents never
// see the SSH key, never choose the host, the GPUs, or the time limit beyond the
// configured cap, and cannot change anything before that slot.

const JOB_ID = /^j\d+-[a-z][a-z0-9_-]{0,31}$/;
const DATASET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,90}$/;
const READ_LIMIT = 200_000;
// A finished job's GPUs are free at once; a cancelled or lost one keeps them
// until its time limit has passed, because its container may still run, unless
// the host has restarted since the job started.
const GRACE_MS = 5 * 60_000;
// A launch makes two host calls of at most 10 minutes each. A job still
// "starting" after this, or whose launching MCP server has exited, was abandoned.
const LAUNCH_MS = 21 * 60_000;
// The host's boot time in seconds since the epoch, on Linux and on macOS.
const BOOT_TIME = `if [ -r /proc/stat ]; then awk '/^btime/ {print $2}' /proc/stat; else sysctl -n kern.boottime | sed 's/^{ sec = \\([0-9]*\\).*/\\1/'; fi`;

const fail = (message) => {
  throw new Error(message);
};
const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
const home = (file) => file.replace(/^~(?=$|\/)/, os.homedir());
// A host path for a shell that has changed directory: relative paths are
// relative to the host user's home, as they are for the first SSH command.
const hostPath = (file) =>
  file.startsWith('/') ? quote(file) : `"$HOME"/${quote(file.replace(/^~\/?/, ''))}`;

/** Run a shell script on the host (over SSH, or locally for host "local"). */
export function hostShell(gpu, script, { input, timeoutMs = 120_000 } = {}) {
  const argv =
    gpu.host === 'local'
      ? ['sh', '-c', script]
      : [
          'ssh',
          '-o',
          'BatchMode=yes',
          '-o',
          'ConnectTimeout=20',
          '-o',
          'StrictHostKeyChecking=accept-new',
          ...(gpu.identity ? ['-i', home(gpu.identity), '-o', 'IdentitiesOnly=yes'] : []),
          gpu.host,
          script,
        ];
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: gpu.host === 'local' ? { ...process.env, HOME: os.homedir() } : process.env,
    });
    let stdout = '',
      stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => (stdout = (stdout + chunk).slice(-1_000_000)));
    child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-100_000)));
    if (input) input.pipe(child.stdin);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** The command for one job: the template with its placeholders filled. */
export function jobCommand(gpu, { job, gpus, seconds, dataset, args }) {
  const fill = (part) =>
    part
      .replaceAll('{job}', job)
      .replaceAll('{gpus}', gpus.join(','))
      .replaceAll('{seconds}', String(seconds));
  const command = [];
  for (const part of gpu.command) {
    if (part === '{args}') command.push(...args);
    else if (part === '{dataset}') {
      if (dataset) command.push(gpu.datasetFlag, `${gpu.datasetTarget}/${dataset}`);
    } else command.push(fill(part));
  }
  return command;
}

export class GpuJobs {
  constructor({ store, run, gpu, shell = hostShell, now = () => Date.now() }) {
    if (!gpu) fail('No GPU host is configured for this run.');
    this.store = store;
    this.run = run;
    this.gpu = gpu;
    this.shell = shell;
    this.now = now;
    this.file = path.join(store.runDir, 'gpu-jobs.json');
  }

  async locked(fn) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const release = await lockfile.lock(this.file, {
      realpath: false,
      retries: { retries: 50, minTimeout: 20, maxTimeout: 300 },
      stale: 60_000,
    });
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  async jobs() {
    try {
      return JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async save(jobs) {
    await atomicWrite(this.file, JSON.stringify(jobs, null, 2) + '\n');
  }

  /** Whether a job still holds its GPUs. */
  holds(job) {
    if (job.state === 'finished' || job.state === 'failed_to_start') return false;
    if (job.hostRestarted) return false;
    return this.now() < Date.parse(job.deadlineAt) + GRACE_MS;
  }

  abandoned(job) {
    return (
      job.state === 'starting' &&
      (!alive(job.launcher) || this.now() - Date.parse(job.startedAt) > LAUNCH_MS)
    );
  }

  /**
   * Settle jobs whose records the host has overtaken: a launch whose MCP server
   * exited before it recorded a pid, and jobs that a host restart ended. One
   * host call; nothing changes while the host is unreachable.
   */
  async reconcile() {
    const jobs = await this.jobs();
    const abandoned = jobs.filter((j) => this.abandoned(j));
    if (!abandoned.length && !jobs.some((j) => this.holds(j) && j.state !== 'starting')) return;
    const probes = abandoned.map(
      (j) => `if [ -e ${quote(j.tree)}/job.log ]; then echo launched; else echo none; fi`,
    );
    const result = await this.shell(this.gpu, [BOOT_TIME, ...probes].join('; '));
    if (result.code !== 0) return;
    const [boot, ...launched] = result.stdout.trim().split('\n');
    const bootedAt = Number(boot) * 1000;
    if (!Number.isFinite(bootedAt) || launched.length !== abandoned.length) return;
    const changes = new Map(
      abandoned.map((j, i) => [
        j.id,
        launched[i] === 'launched'
          ? { state: 'lost', error: 'Its MCP server exited before the job reported its process.' }
          : {
              state: 'failed_to_start',
              error: 'Its MCP server exited before the job started; nothing runs on the host.',
            },
      ]),
    );
    await this.locked(async () => {
      const current = await this.jobs();
      for (const job of current) {
        const change = changes.get(job.id);
        if (change && job.state === 'starting') Object.assign(job, change);
        if (this.holds(job) && job.state !== 'starting' && Date.parse(job.startedAt) < bootedAt)
          Object.assign(job, {
            state: job.state === 'running' ? 'lost' : job.state,
            hostRestarted: true,
          });
      }
      await this.save(current);
    });
  }

  freeGpus(jobs) {
    const busy = new Set(jobs.filter((j) => this.holds(j)).flatMap((j) => j.gpus));
    return this.gpu.gpus.filter((id) => !busy.has(id));
  }

  tree(id) {
    return `${this.gpu.dir}/${this.run.id.slice(0, 8)}/${id}`;
  }

  /**
   * Start a job on a pushed commit. GPUs are reserved under a lock, so agents
   * starting jobs at the same time never share one.
   */
  async start({ agent, commit, gpus = 1, minutes, dataset, args }) {
    if (!Number.isInteger(gpus) || gpus < 1) fail('Ask for at least one GPU.');
    await this.reconcile();
    const limit = this.gpu.maxMinutes;
    minutes = Math.min(minutes ?? limit, limit);
    if (!(minutes > 0)) fail('A job needs a positive time limit.');
    if (dataset !== undefined && !DATASET.test(dataset)) fail(`Invalid dataset name: ${dataset}`);
    if (dataset !== undefined && !this.gpu.datasetFlag)
      fail('This GPU host takes no datasets; leave dataset out.');
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string'))
      fail('args must be a list of strings.');
    const job = await this.locked(async () => {
      const jobs = await this.jobs();
      const free = this.freeGpus(jobs);
      if (gpus > free.length)
        fail(
          `Only ${free.length} of ${this.gpu.gpus.length} GPUs are free (${free.join(', ') || 'none'}). Check gpu_jobs and try again when one finishes.`,
        );
      const id = `j${jobs.length + 1}-${agent}`;
      if (!JOB_ID.test(id)) fail(`Invalid job name ${id}.`);
      const entry = {
        id,
        agent,
        commit,
        gpus: free.slice(0, gpus),
        minutes,
        dataset: dataset ?? null,
        args,
        state: 'starting',
        startedAt: new Date(this.now()).toISOString(),
        deadlineAt: new Date(this.now() + (minutes + 10) * 60_000).toISOString(),
        tree: this.tree(id),
        launcher: process.pid,
        pid: null,
        exitCode: null,
        error: null,
      };
      jobs.push(entry);
      await this.save(jobs);
      return entry;
    });
    try {
      await this.launch(job);
    } catch (error) {
      await this.update(job.id, { state: 'failed_to_start', error: error.message });
      throw error;
    }
    return this.status(job.id);
  }

  async update(id, changes) {
    return this.locked(async () => {
      const jobs = await this.jobs();
      const job = jobs.find((j) => j.id === id);
      Object.assign(job, changes);
      await this.save(jobs);
      return job;
    });
  }

  async launch(job) {
    const { gpu } = this;
    const tree = job.tree;
    const archive = spawn('git', ['archive', '--format=tar', job.commit], {
      cwd: this.run.origin,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let archiveError = '';
    archive.stderr.on('data', (chunk) => (archiveError += chunk));
    const archived = new Promise((resolve) => archive.on('close', resolve));
    const unpack = await this.shell(
      gpu,
      `set -e; mkdir -p ${quote(tree)}; tar -x -C ${quote(tree)}; printf '%s\\n' ${quote(job.commit)} > ${quote(tree)}/COMMIT`,
      { input: archive.stdout, timeoutMs: 600_000 },
    );
    if ((await archived) !== 0 || unpack.code !== 0)
      fail(`Copying the code to the GPU host failed: ${(archiveError || unpack.stderr).trim()}`);
    const steps = [`cd ${quote(tree)}`];
    if (gpu.prepare) steps.push(gpu.prepare);
    if (job.dataset)
      steps.push(
        `mkdir -p ${quote(gpu.datasetTarget)}`,
        `cp -R ${hostPath(`${gpu.datasetSource}/${job.dataset}`)} ${quote(`${gpu.datasetTarget}/${job.dataset}`)}`,
      );
    const command = jobCommand(gpu, {
      job: job.id,
      gpus: job.gpus,
      seconds: Math.round(job.minutes * 60),
      dataset: job.dataset,
      args: job.args,
    });
    // Job control (set -m) gives the job a process group of its own, so cancel
    // can stop all of it; setsid is missing on macOS. The braces keep the launch
    // inside the && chain: a failed step before it starts nothing.
    const body = `${command.map(quote).join(' ')}; echo $? > exit-code`;
    steps.push(
      `printf '%s\\n' ${quote(command.map(quote).join(' '))} > job.cmd`,
      `{ set -m; nohup sh -c ${quote(body)} > job.log 2>&1 < /dev/null & echo $!; }`,
    );
    const started = await this.shell(gpu, `set -e; ${steps.join(' && ')}`, { timeoutMs: 600_000 });
    const pid = Number(started.stdout.trim().split('\n').at(-1));
    if (started.code !== 0 || !Number.isInteger(pid))
      fail(`Starting the job failed: ${(started.stderr || started.stdout).trim().slice(-1000)}`);
    await this.update(job.id, { state: 'running', pid });
  }

  /** A job's state and the end of its log; records the exit code once it has one. */
  async status(id) {
    const jobs = await this.jobs();
    const job = jobs.find((j) => j.id === id) ?? fail(`No job named ${id}.`);
    if (job.state === 'starting' || job.state === 'failed_to_start') return { ...job, log: null };
    const result = await this.shell(
      this.gpu,
      `cd ${quote(job.tree)} || exit 3; if [ -f exit-code ]; then echo "exit $(cat exit-code)"; elif kill -0 ${job.pid} 2>/dev/null; then echo running; else echo lost; fi; echo ---; tail -c 6000 job.log 2>/dev/null`,
    );
    if (result.code !== 0)
      return { ...job, log: null, error: `GPU host unreachable: ${result.stderr.trim()}` };
    const [head, ...rest] = result.stdout.split('\n---\n');
    const changes = {};
    if (head.startsWith('exit ') && job.state !== 'finished')
      Object.assign(changes, { state: 'finished', exitCode: Number(head.slice(5)) });
    else if (head.trim() === 'lost' && job.state === 'running') changes.state = 'lost';
    const updated = Object.keys(changes).length ? await this.update(id, changes) : job;
    return { ...updated, log: rest.join('\n---\n') };
  }

  /** Every job of this run, refreshing the ones still running. */
  async list() {
    await this.reconcile();
    const jobs = await this.jobs();
    const out = [];
    for (const job of jobs) {
      const current = job.state === 'running' ? await this.status(job.id) : job;
      const { log, ...rest } = current;
      out.push(rest);
    }
    return { gpus: this.gpu.gpus, free: this.freeGpus(await this.jobs()), jobs: out };
  }

  /** Text of a file the job wrote, by path relative to its directory. */
  async read(id, file, { maxBytes = 50_000 } = {}) {
    const job = (await this.jobs()).find((j) => j.id === id) ?? fail(`No job named ${id}.`);
    const relative = path.posix.normalize(file);
    if (path.posix.isAbsolute(relative) || relative.startsWith('..'))
      fail('Give a path inside the job directory.');
    const bytes = Math.min(maxBytes, READ_LIMIT);
    const result = await this.shell(
      this.gpu,
      `cd ${quote(job.tree)} && if [ -d ${quote(relative)} ]; then find ${quote(relative)} -maxdepth 3 -type f | head -300; else head -c ${bytes} ${quote(relative)}; fi`,
    );
    if (result.code !== 0) fail(`Could not read ${relative}: ${result.stderr.trim()}`);
    return result.stdout;
  }

  /** Stop a job's process group. Its GPUs stay reserved until its time limit. */
  async cancel(id) {
    const job = (await this.jobs()).find((j) => j.id === id) ?? fail(`No job named ${id}.`);
    if (job.state !== 'running') fail(`Job ${id} is ${job.state}, not running.`);
    await this.shell(this.gpu, `kill -TERM -${job.pid} 2>/dev/null || true`);
    return this.update(id, { state: 'cancelled' });
  }
}
