import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventWriter } from './tensorboard.js';
import { readTranscript } from './chat.js';
import { checkoutCommit, git, originHead, originLog } from './workspace.js';
import { delay, runCommand } from './process.js';

// TensorBoard scalars for a run, sampled while it works: how main grows, what
// the agents are doing, what they spend, how much they talk, and how loaded
// the machine is. An optional score command measures progress on main at
// intervals, as SwarmChat scored workspace snapshots every 15 minutes.

const STATES = ['starting', 'working', 'waiting', 'backoff', 'retired', 'stopped'];

/** A run's folder name: sortable by start, then size and goal, readable in TensorBoard. */
export function runLabel(run) {
  const slug = run.goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `${run.createdAt.slice(0, 19).replace(/:/g, '-')}_${run.agents.length}agents_${slug || run.id.slice(0, 8)}`;
}

/** The last "x/y" (or else the last number) a score command printed. */
export function parseScore(text) {
  const fractions = [...text.matchAll(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/g)];
  if (fractions.length) {
    const [, x, y] = fractions.at(-1);
    return { score: Number(x), fraction: Number(y) ? Number(x) / Number(y) : null };
  }
  const numbers = text.match(/-?\d+(?:\.\d+)?/g);
  return numbers ? { score: Number(numbers.at(-1)), fraction: null } : null;
}

/** Resident memory, in bytes, of every process in these process groups. */
async function groupMemory(pids) {
  if (!pids.length) return 0;
  const ps = await runCommand(['ps', '-A', '-o', 'pgid=,rss='], {
    timeoutMs: 5000,
    maxBytes: 4_000_000,
  });
  const groups = new Set(pids);
  let kb = 0;
  for (const line of ps.stdout.split('\n')) {
    const [pgid, rss] = line.trim().split(/\s+/).map(Number);
    if (groups.has(pgid)) kb += rss;
  }
  return kb * 1024;
}

export class RunMonitor {
  constructor({ dir, run, store, config }) {
    this.run = run;
    this.store = store;
    this.config = config;
    this.dir = path.join(dir, runLabel(run));
    this.writer = new EventWriter(this.dir);
    this.loggedRounds = 0;
    this.lastScore = null;
  }

  step() {
    return Math.max(0, Math.round((Date.now() - Date.parse(this.run.startedAt)) / 1000));
  }

  async sample() {
    const { run } = this;
    const head = await originHead(run.origin);
    const commits = await originLog(run.origin, run.base.commit);
    const stat = (await git(run.origin, ['diff', '--shortstat', run.base.commit, head])).stdout
      .toString()
      .match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
    const transcript = await readTranscript(this.store.chatDir, { since: run.createdAt });
    const agents = run.agents;
    const sum = (list, key) => list.reduce((total, a) => total + (a.usage[key] ?? 0), 0);
    const tokens = (list) => sum(list, 'inputTokens') + sum(list, 'outputTokens');
    const values = {
      'main/commits': commits.length,
      'main/files_changed': stat ? Number(stat[1]) : 0,
      'main/lines_changed': stat ? Number(stat[2] ?? 0) + Number(stat[3] ?? 0) : 0,
      'main/committers': new Set(commits.map((c) => c.author)).size,
      'sessions/total': agents.reduce((total, a) => total + a.sessions, 0),
      'sessions/failed': agents.reduce((total, a) => total + a.failures, 0),
      'sessions/rate_limited': agents.reduce((total, a) => total + a.rateLimited, 0),
      'tokens/total': tokens(agents),
      'tokens/input': sum(agents, 'inputTokens'),
      'tokens/cached_input': sum(agents, 'cachedInputTokens'),
      'tokens/output': sum(agents, 'outputTokens'),
      'tokens/claude': tokens(agents.filter((a) => a.backend === 'claude')),
      'tokens/codex': tokens(agents.filter((a) => a.backend === 'codex')),
      'cost/claude_code_usd': sum(agents, 'costUsd'),
      'chat/messages': transcript.length,
      'chat/general': transcript.filter((m) => m.chat === '#general').length,
      'chat/direct': transcript.filter((m) => !m.chat.startsWith('#')).length,
      'machine/load_1m': os.loadavg()[0],
      'machine/free_memory_gb': os.freemem() / 2 ** 30,
      'machine/agent_memory_gb':
        (await groupMemory(agents.map((a) => a.pid).filter(Boolean))) / 2 ** 30,
    };
    for (const state of STATES)
      values[`agents/${state}`] = agents.filter((a) => a.state === state).length;
    for (const agent of agents) {
      values[`agent_tokens/${agent.id}`] = tokens([agent]);
      values[`agent_sessions/${agent.id}`] = agent.sessions;
    }
    const authors = commits.reduce(
      (map, c) => map.set(c.author, (map.get(c.author) ?? 0) + 1),
      new Map(),
    );
    for (const agent of agents) values[`agent_commits/${agent.id}`] = authors.get(agent.id) ?? 0;
    for (const round of run.checkRounds.slice(this.loggedRounds)) {
      values['checks/passed_fraction'] =
        round.results.filter((r) => r.passed).length / Math.max(1, round.results.length);
      this.loggedRounds++;
    }
    this.writer.scalars(values, this.step());
  }

  /** Run the score command on main in a clean checkout and record what it printed. */
  async score() {
    const { run, config } = this;
    if (!config.scoreCommand.length) return null;
    const commit = await originHead(run.origin);
    const dir = path.join(this.store.runDir, 'score', randomUUID());
    try {
      const cwd = await checkoutCommit(run.origin, run.base, commit, dir);
      const result = await runCommand(config.scoreCommand, {
        cwd,
        timeoutMs: config.checkTimeoutSeconds * 1000,
        maxBytes: 64000,
      });
      const parsed = parseScore(`${result.stdout}\n${result.stderr}`);
      if (parsed) {
        const values = { 'progress/score': parsed.score };
        if (parsed.fraction !== null) values['progress/score_fraction'] = parsed.fraction;
        this.writer.scalars(values, this.step());
      }
      this.lastScore = parsed && { ...parsed, commit };
      return this.lastScore;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  /** Sample until `signal` aborts; score every `scoreSeconds`. */
  async watch(signal) {
    let lastScore = 0;
    while (!signal.aborted) {
      await this.sample().catch(() => {});
      if (
        this.config.scoreCommand.length &&
        Date.now() - lastScore >= this.config.scoreSeconds * 1000
      ) {
        lastScore = Date.now();
        await this.score().catch(() => {});
      }
      await delay(this.config.monitorSeconds * 1000, signal);
    }
  }

  /** One last sample and score of the final main, then close the file. */
  async finish() {
    try {
      await this.sample().catch(() => {});
      await this.score().catch(() => {});
    } finally {
      this.writer.close();
    }
    return this.lastScore;
  }
}
