import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { configSchema } from './schema.js';

// `.collab/state.json` holds the project's settings and its latest run. The
// supervisor is its main writer; CLI commands such as `stop` write through the
// same lock. Earlier runs move to `.collab/history/`.

export const STATE_VERSION = 3;
const OPEN = new Set(['starting', 'running']);
// Settings from the two-agent protocol that still mean the same thing.
const CARRIED_SETTINGS = [
  'preset',
  'deadlineMinutes',
  'checkTimeoutSeconds',
  'memory',
  'dependencyDirs',
  'checks',
];

export const isOpen = (run) => OPEN.has(run?.status);

export async function atomicWrite(file, content, mode = 0o600) {
  const temp = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temp, 'wx', mode);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temp, file);
  } finally {
    await handle?.close();
    await fs.rm(temp, { force: true });
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** True while a process with this PID exists. */
export function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export class Store {
  constructor(root) {
    this.root = path.resolve(root);
    this.dir = path.join(this.root, '.collab');
    this.file = path.join(this.dir, 'state.json');
    this.runDir = path.join(this.dir, 'run');
    this.chatDir = path.join(this.dir, 'chat');
    this.historyDir = path.join(this.dir, 'history');
    this.tokensFile = path.join(this.runDir, 'tokens.json');
    // One in-process queue in front of the file lock: a supervisor's agent
    // loops would otherwise contend for the lock among themselves.
    this.queue = Promise.resolve();
  }

  async locked(fn) {
    const task = this.queue.then(async () => {
      await fs.mkdir(this.dir, { recursive: true });
      const release = await lockfile.lock(path.join(this.dir, 'state'), {
        realpath: false,
        retries: { retries: 50, minTimeout: 10, maxTimeout: 200 },
        stale: 10000,
      });
      try {
        return await fn();
      } finally {
        await release();
      }
    });
    this.queue = task.catch(() => {});
    return task;
  }

  /** The current state, or null before `init`. Earlier formats are upgraded in memory. */
  async load() {
    const state = await readJson(this.file);
    if (!state || state.schemaVersion === STATE_VERSION) return state;
    // The two-agent protocol kept a `session`; it cannot continue as a swarm.
    const carried = Object.fromEntries(
      CARRIED_SETTINGS.filter((key) => key in (state.config ?? {})).map((key) => [
        key,
        state.config[key],
      ]),
    );
    return { schemaVersion: STATE_VERSION, config: configSchema.parse(carried), run: null };
  }

  async read() {
    const state = await this.load();
    if (!state) throw new Error('Run model-collab init first.');
    return state;
  }

  async write(state) {
    await atomicWrite(this.file, JSON.stringify(state, null, 2) + '\n');
    await atomicWrite(path.join(this.dir, 'README.md'), renderReadme(state), 0o644);
  }

  /** Read, let `fn` change the state, and write it back; returns what `fn` returns. */
  async update(fn) {
    return this.locked(async () => {
      const state = await this.read();
      const result = await fn(state);
      await this.write(state);
      return result;
    });
  }

  async init(options = {}) {
    const config = configSchema.parse(options);
    return this.locked(async () => {
      if (await this.load()) throw new Error('Already initialized. Existing settings were kept.');
      const state = { schemaVersion: STATE_VERSION, config, run: null };
      await this.write(state);
      await prepareProject(this.root, config);
      return state;
    });
  }

  async configure(changes) {
    const state = await this.update((state) => {
      if (isOpen(state.run)) throw new Error('Change settings after the current run ends.');
      state.config = configSchema.parse({ ...state.config, ...changes });
      return state;
    });
    await prepareProject(this.root, state.config);
    return state;
  }

  /** Move the finished run's record and logs to history; agents' clones are deleted. */
  async archiveRun(run) {
    if (!run) return;
    await fs.mkdir(this.historyDir, { recursive: true });
    await atomicWrite(
      path.join(this.historyDir, `${run.id}.json`),
      JSON.stringify(run, null, 2) + '\n',
    );
    const exists = await fs.stat(this.runDir).catch(() => null);
    if (!exists) return;
    for (const name of ['work', 'git', 'check', 'score', 'result', 'tokens.json'])
      await fs.rm(path.join(this.runDir, name), { recursive: true, force: true });
    await fs.rename(this.runDir, path.join(this.historyDir, run.id));
  }
}

const writeOnce = (file, text) =>
  fs.writeFile(file, text, { flag: 'wx' }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });

/**
 * Shared context files and a .gitignore entry, created once per project; the
 * research preset adds a brief for the question, sources, and budget.
 */
export async function prepareProject(root, config = {}) {
  const dir = path.join(root, '.collab');
  await fs.mkdir(dir, { recursive: true });
  await writeOnce(
    path.join(dir, 'CONTEXT.md'),
    '# Shared project context\n\nAdd architecture, constraints, relevant paths, and commands here. Every agent reads this file at the start of each session.\n',
  );
  if (config.preset === 'research')
    await writeOnce(
      path.join(dir, 'RESEARCH.md'),
      '# Research brief\n\n- Research question:\n- Environment / dataset:\n- Relevant papers and source locations:\n- Existing implementation and baselines:\n- Compute, time, and data constraints:\n- Success metrics and uncertainty:\n- Known findings and unresolved assumptions:\n\nFill this in with project-specific context. Leave unknowns explicit.\n',
    );
  const ignorePath = path.join(root, '.gitignore');
  const ignore = await fs.readFile(ignorePath, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  if (!ignore.split(/\r?\n/).includes('.collab/'))
    await fs.writeFile(
      ignorePath,
      `${ignore}${ignore && !ignore.endsWith('\n') ? '\n' : ''}.collab/\n`,
    );
}

function renderReadme(state) {
  const run = state.run;
  if (!run) return '# Model Collab\n\nNo run yet. Start one with `model-collab up "your goal"`.\n';
  const agents = run.agents
    .map(
      (a) =>
        `| ${a.id} | ${a.state} | ${a.sessions} | ${a.usage.inputTokens + a.usage.outputTokens} | ${(a.lastSummary ?? '').replace(/\s+/g, ' ').slice(0, 120)} |`,
    )
    .join('\n');
  const result = run.result
    ? `\nResult: ${run.result.commits} commits, ending at ${run.result.commit.slice(0, 12)}. ${
        run.result.applied
          ? `Applied to your working tree: ${run.result.applied.join(', ') || 'no file changes'}.`
          : run.result.error
            ? `Not applied: ${run.result.error}`
            : 'Not applied; run `model-collab apply` to take it.'
      }\n`
    : '';
  return `# Model Collab run ${run.id}\n\nThis file is generated; do not edit it.\n\nStatus: **${run.status}**${run.stopReason ? ` (${run.stopReason})` : ''}. Started ${run.startedAt ?? run.createdAt}; deadline ${run.deadlineAt}.\n\nGoal: ${run.goal}\n${result}\n| Agent | State | Sessions | Tokens | Last summary |\n| --- | --- | --- | --- | --- |\n${agents}\n\nWatch the chat with \`model-collab view\`.\n`;
}
