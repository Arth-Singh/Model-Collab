import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { configSchema, goalSchema } from './schema.js';
import { Store, alive, atomicWrite, isOpen } from './store.js';
import {
  ChatClient,
  GENERAL,
  HUMAN,
  SYSTEM,
  ensureChannel,
  provisionUsers,
  startServer,
  stopStaleServer,
} from './chat.js';
import {
  applyChanges,
  captureBase,
  checkoutCommit,
  cloneForAgent,
  commitChanges,
  createOrigin,
  git,
  originHead,
  originLog,
} from './workspace.js';
import { BACKENDS, runSession } from './agent.js';
import { DEFAULT_EFFORT, DEFAULT_MODELS, delay, runCommand } from './process.js';
import { RunMonitor, tensorboardDir } from './monitor.js';

// A run: capture the project, give every agent a clone of a shared origin and
// a chat account, then keep each agent in a loop of fresh sessions until the
// swarm goes quiet and the checks pass, the deadline passes, or the user stops
// it. Agents decide among themselves who does what; the supervisor only
// schedules sessions, wakes waiting agents when a message reaches them, and
// judges the end.

export const binPath = fileURLToPath(new URL('../bin/model-collab.js', import.meta.url));
const swarmContract = await fs.readFile(new URL('../prompts/swarm.md', import.meta.url), 'utf8');
const researchContract = await fs.readFile(
  new URL('../prompts/research.md', import.meta.url),
  'utf8',
);

const TICK_MS = 1000;
const WAKE_POLL_SECONDS = 20;
const MAX_CONSECUTIVE_FAILURES = 5;
const CONTEXT_FILES = ['CONTEXT.md', 'RESEARCH.md', 'MEMORY.md'];

const now = () => new Date().toISOString();
const zeroUsage = () => ({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 });

/** Agent IDs, interleaved so both backends start early: claude-1, codex-1, claude-2, ... */
export function rosterFor(config) {
  const roster = [];
  for (let i = 1; i <= Math.max(config.claude, config.codex); i++)
    for (const backend of BACKENDS)
      if (i <= config[backend]) roster.push({ id: `${backend}-${i}`, backend });
  return roster;
}

async function sharedContext(dir) {
  const parts = await Promise.all(
    CONTEXT_FILES.map(async (name) => {
      const text = await fs.readFile(path.join(dir, name), 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      return text.trim() ? `${name}\n${text.slice(0, 16000)}` : '';
    }),
  );
  return parts.filter(Boolean).join('\n\n');
}

function describeTeam(agents) {
  const names = { claude: 'Claude Code', codex: 'Codex' };
  return BACKENDS.map((backend) => {
    const ids = agents.filter((a) => a.backend === backend).map((a) => a.id);
    return ids.length ? `${ids.join(', ')} (${names[backend]})` : null;
  })
    .filter(Boolean)
    .join('; ');
}

/** The prompt for one session: the contract, then the facts of this run. */
export function sessionPrompt({ run, config, agent, context }) {
  const minutesLeft = Math.max(0, Math.round((Date.parse(run.deadlineAt) - Date.now()) / 60000));
  const checks = Object.entries(config.checks);
  const lines = [
    swarmContract,
    ...(config.preset === 'research' ? [researchContract] : []),
    'THIS RUN',
    `You are ${agent.id}, one of ${run.agents.length} agents: ${describeTeam(run.agents)}.`,
    `Your workspace is ${agent.workspace}, your own clone of the shared repository. Edit files only there and push to origin main.`,
    `Deadline: ${run.deadlineAt} (about ${minutesLeft} minutes left). This is your session ${agent.sessions}; the harness starts a fresh session after you return.`,
    agent.lastSummary
      ? `Your previous session's summary:\n${agent.lastSummary}`
      : 'This is your first session. Read #general for the goal and the claims made so far.',
    ...(agent.lastFailure ? [`Your previous session ended early: ${agent.lastFailure}`] : []),
    checks.length
      ? `Configured checks (swarm_check runs one on main): ${checks.map(([name, argv]) => `${name}: ${argv.join(' ')}`).join('; ')}.`
      : 'No checks are configured. Agree on a shared test command in #general.',
    ...(config.gpu
      ? [
          `GPU host: ${config.gpu.gpus.length} GPUs (${config.gpu.gpus.join(', ')}), shared by the whole swarm, through gpu_run, gpu_jobs, gpu_status, gpu_read, and gpu_cancel. A job runs a commit already on origin in a fresh directory as: ${config.gpu.command.join(' ')}. Your args fill {args}; at most ${config.gpu.maxMinutes} minutes per job. Check gpu_jobs before you start one, announce it in #general with its purpose, and follow the repository's rules for runs.`,
        ]
      : []),
    '',
    "THE USER'S GOAL",
    run.goal,
    ...(run.criteria.length ? ['', 'Success criteria:', ...run.criteria.map((c) => `- ${c}`)] : []),
    '',
    'SHARED CONTEXT',
    context || '(none)',
    '',
    'Return JSON with `next` ("continue" or "wait") and `summary` when you end this session.',
  ];
  return lines.join('\n');
}

/** The MCP server command an agent's CLI starts to reach the chat and run state. */
export function mcpServer(root, agentId) {
  return {
    command: process.execPath,
    args: [binPath, 'serve', '--repo', root, '--agent', agentId],
  };
}

async function resolveCommand(command) {
  if (command.includes('/')) return command;
  const found = await runCommand(['/usr/bin/env', 'which', command], { timeoutMs: 5000 });
  if (found.code !== 0 || !found.stdout.trim())
    throw new Error(
      `${command} is not on PATH. Install SwarmChat with: uv tool install swarmchat==0.1.0`,
    );
  return found.stdout.trim();
}

/**
 * Stop agent sessions a dead supervisor left running. Each session leads its
 * own process group; a PID is signalled only while it is still an agent CLI.
 */
export async function stopOrphans(agents = []) {
  let stopped = 0;
  for (const { pid, backend } of agents) {
    if (!pid || !alive(pid)) continue;
    const ps = await runCommand(['ps', '-p', String(pid), '-o', 'command='], { timeoutMs: 5000 });
    if (ps.code !== 0 || !ps.stdout.includes(backend)) continue;
    try {
      process.kill(-pid, 'SIGTERM');
      stopped++;
    } catch {
      /* Already gone. */
    }
  }
  return stopped;
}

/**
 * Close a run whose supervisor died: stop what it left running and record its
 * origin's `main` as the result, so `apply` can still take it.
 */
async function closeDeadRun(run, status, reason) {
  await stopOrphans(run.agents);
  await stopStaleServer(run.chat?.pid);
  run.status = status;
  run.stopReason = reason;
  run.endedAt = now();
  for (const agent of run.agents ?? []) agent.pid = null;
  if (run.origin && run.base && !run.result) {
    const commit = await originHead(run.origin).catch(() => null);
    if (commit)
      run.result = {
        commit,
        commits: (await originLog(run.origin, run.base.commit)).length,
        files: [],
        applied: null,
        error: null,
      };
  }
}

/** End a run whose supervisor died, so a new run can start. */
async function recoverStaleRun(store) {
  const state = await store.load();
  if (!isOpen(state?.run)) return;
  if (alive(state.run.supervisorPid))
    throw new Error(
      `A run is in progress (supervisor PID ${state.run.supervisorPid}). Stop it with model-collab stop.`,
    );
  await store.update((s) =>
    closeDeadRun(s.run, 'failed', 'The supervisor exited before the run ended.'),
  );
}

/** Run checks on `commit` in a clean checkout. */
export async function runChecks({
  store,
  run,
  config,
  commit,
  names = Object.keys(config.checks),
}) {
  const results = [];
  for (const name of names) {
    const argv = config.checks[name];
    if (!argv)
      throw new Error(
        `No check named ${name}. Configured: ${Object.keys(config.checks).join(', ') || 'none'}.`,
      );
    const dir = path.join(store.runDir, 'check', randomUUID());
    try {
      const cwd = await checkoutCommit(run.origin, run.base, commit, dir);
      const result = await runCommand(argv, {
        cwd,
        timeoutMs: config.checkTimeoutSeconds * 1000,
        maxBytes: 4000,
      });
      results.push({
        name,
        passed: result.code === 0 && !result.error,
        code: result.code,
        error: result.error ?? null,
        output: `${result.stdout}\n${result.stderr}`.trim().slice(-2000),
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
  return results;
}

/**
 * Start a run and supervise it to the end. Resolves with the final run record.
 * `session` replaces the agent CLI in tests.
 */
export async function runSwarm({
  root,
  goal,
  criteria = [],
  overrides = {},
  onEvent = () => {},
  signal,
  session = runSession,
  env = process.env,
  // Backoff before retrying a failed session, doubled after each failure in a row.
  retryDelays = { error: 10_000, rate_limited: 60_000 },
}) {
  root = path.resolve(root);
  ({ goal, criteria } = goalSchema.parse({ goal, criteria }));
  const report = onEvent;
  onEvent = (event) => report({ at: now(), ...event });
  const store = new Store(root);
  if (!(await store.load())) await store.init();
  await recoverStaleRun(store);
  const stored = await store.read();
  const config = configSchema.parse({ ...stored.config, ...overrides });
  await store.archiveRun(stored.run);

  const runId = randomUUID();
  const base = await captureBase(root, path.join(store.dir, 'tmp'), config.dependencyDirs);
  const origin = await createOrigin(base, path.join(store.runDir, 'origin.git'));
  const chatCommand = await resolveCommand(config.chatCommand);
  const agents = rosterFor(config).map(({ id, backend }) => ({
    id,
    backend,
    model: config.models[backend] ?? DEFAULT_MODELS[backend],
    effort: config.effort ?? DEFAULT_EFFORT,
    serviceTier: backend === 'codex' ? (config.codexServiceTier ?? null) : null,
    cloneDir: path.join(store.runDir, 'work', id),
    gitDir: path.join(store.runDir, 'git', id),
    workspace: null,
    state: 'starting',
    sessions: 0,
    failures: 0,
    rateLimited: 0,
    usage: zeroUsage(),
    lastSummary: null,
    lastFailure: null,
    retiredReason: null,
    pid: null,
  }));
  for (const agent of agents)
    agent.workspace = await cloneForAgent(base, origin, {
      workspace: agent.cloneDir,
      gitDir: agent.gitDir,
      name: agent.id,
    });

  const server = await startServer({ command: chatCommand, dataDir: store.chatDir });
  const createdAt = now();
  const run = {
    kind: 'swarm',
    id: runId,
    goal,
    criteria,
    status: 'starting',
    stopReason: null,
    stopRequested: null,
    createdAt,
    startedAt: null,
    deadlineAt: new Date(Date.now() + config.deadlineMinutes * 60000).toISOString(),
    endedAt: null,
    supervisorPid: process.pid,
    config,
    base,
    origin,
    chat: { url: server.url, pid: server.pid, command: chatCommand, dataDir: store.chatDir },
    agents,
    checkRounds: [],
    notes: [],
    result: null,
  };
  const controller = new AbortController();
  const runSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let ended = null,
    monitor = null;
  try {
    const tokens = await provisionUsers({
      command: chatCommand,
      dataDir: store.chatDir,
      ids: [SYSTEM, HUMAN, ...agents.map((a) => a.id)],
    });
    await atomicWrite(store.tokensFile, JSON.stringify(tokens));
    const system = new ChatClient({ command: chatCommand, url: server.url, token: tokens[SYSTEM] });
    const human = new ChatClient({ command: chatCommand, url: server.url, token: tokens[HUMAN] });
    const clients = Object.fromEntries(
      agents.map((a) => [
        a.id,
        new ChatClient({ command: chatCommand, url: server.url, token: tokens[a.id] }),
      ]),
    );
    await ensureChannel(
      system,
      GENERAL,
      [SYSTEM, HUMAN, ...agents.map((a) => a.id)],
      'The whole swarm',
    );
    const generalId = (await system.info(GENERAL)).id;
    // Older messages belong to earlier runs; agents start reading from this goal.
    for (const client of Object.values(clients)) await client.read({ limit: 1000 });
    await system.read({ limit: 1000 });
    await store.update((state) => {
      state.run = run;
    });
    await human.send(
      `#${GENERAL}`,
      `Goal (run ${runId}):\n${goal}${criteria.length ? `\n\nSuccess criteria:\n${criteria.map((c) => `- ${c}`).join('\n')}` : ''}\n\nTeam: ${describeTeam(agents)}. Deadline: ${run.deadlineAt}.`,
    );
    run.status = 'running';
    run.startedAt = now();
    await persist();
    onEvent({
      event: 'started',
      runId,
      agents: agents.map((a) => ({ id: a.id, backend: a.backend, model: a.model })),
      deadlineAt: run.deadlineAt,
      chatUrl: server.url,
    });
    if (config.tensorboard) {
      monitor = new RunMonitor({
        dir: tensorboardDir(root, config, env),
        run,
        store,
        config,
      });
      onEvent({ event: 'monitor', dir: monitor.dir });
    }
    const watching = monitor?.watch(runSignal);

    const context = await sharedContext(store.dir);
    const loops = agents.map((agent, index) =>
      agentLoop(agent, index, clients[agent.id], context, generalId).catch((error) =>
        retire(agent, `supervisor error: ${error.message}`),
      ),
    );
    await coordinate(system);
    controller.abort();
    await Promise.all([...loops, watching]);
    await finish(system);
    if (monitor) {
      const score = await monitor.finish();
      monitor = null;
      if (score) {
        run.result.score = score;
        await persist();
        onEvent({ event: 'score', ...score });
      }
    }
    return run;
  } catch (error) {
    controller.abort();
    monitor?.writer.close();
    if (!run.endedAt) {
      run.status = 'failed';
      run.stopReason = `${ended ? `${ended.status}, then ` : ''}the supervisor failed: ${error.message}`;
      run.endedAt = now();
      await persist().catch(() => {});
    }
    throw error;
  } finally {
    await server.stop();
  }

  /** Write the run; the user's stop request and notes arrive through the file. */
  async function persist() {
    await store.update((state) => {
      if (state.run?.id === run.id) {
        run.stopRequested ??= state.run.stopRequested;
        run.notes = state.run.notes;
      }
      state.run = run;
    });
  }

  function retire(agent, reason) {
    agent.state = 'retired';
    agent.retiredReason = reason;
    onEvent({ event: 'retired', agent: agent.id, reason });
    return persist();
  }

  /**
   * Block until a message that needs this agent arrives after its last session
   * started: a direct message, a post in a channel other than #general, an
   * @mention, a post with @all, or a post from the user or the harness. Plain
   * status posts in #general wake nobody; otherwise every "done" message would
   * start a session in every waiting agent, and those would post again.
   */
  async function wake(agent, client, since, generalId) {
    const q = JSON.stringify;
    const where = [
      `m.at > ${q(since)}`,
      `m.sender != ${q(agent.id)}`,
      `(m.sender in (${q(HUMAN)}, ${q(SYSTEM)}) or m.chat != ${q(generalId)} or ${q(agent.id)} in (m.mentions or []) or '@all' in m.text)`,
    ].join(' and ');
    while (!runSignal.aborted) {
      const messages = await client
        .wait({ timeoutSeconds: WAKE_POLL_SECONDS, peek: true, where, signal: runSignal })
        .catch(() => []);
      if (runSignal.aborted) return false;
      if (messages.length) return true;
    }
    return false;
  }

  async function agentLoop(agent, index, client, context, generalId) {
    await delay(index * config.staggerSeconds * 1000, runSignal);
    let next = 'continue',
      lastStarted = run.startedAt,
      streak = 0;
    while (!runSignal.aborted) {
      if (next === 'wait') {
        agent.state = 'waiting';
        await persist();
        if (!(await wake(agent, client, lastStarted, generalId))) return;
        onEvent({ event: 'woke', agent: agent.id });
      }
      if (agent.sessions >= config.maxSessions)
        return retire(agent, `reached the limit of ${config.maxSessions} sessions`);
      // Past the deadline a session would end before it starts; the coordinator
      // ends the run on its next tick.
      if (Date.now() >= Date.parse(run.deadlineAt)) return;
      agent.sessions++;
      agent.state = 'working';
      lastStarted = now();
      await persist();
      onEvent({ event: 'session', agent: agent.id, number: agent.sessions });
      const result = await session({
        agent,
        origin: run.origin,
        mcp: mcpServer(root, agent.id),
        prompt: sessionPrompt({ run, config, agent, context }),
        logDir: path.join(store.runDir, 'logs', agent.id),
        timeoutMs: config.sessionMinutes * 60000,
        deadlineMs: Date.parse(run.deadlineAt),
        signal: runSignal,
        env,
        passEnv: config.passEnv,
        onLaunch: (pid) => {
          agent.pid = pid;
          persist().catch(() => {});
        },
      });
      agent.pid = null;
      for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens'])
        agent.usage[key] += result.usage?.[key] ?? 0;
      agent.usage.costUsd += result.usage?.costUsd ?? 0;
      const failure = result.failure;
      if (failure?.kind === 'aborted') return persist();
      if (failure && failure.kind !== 'timeout') {
        agent.failures++;
        streak++;
        if (failure.kind === 'rate_limited') agent.rateLimited++;
        agent.lastFailure = `${failure.kind}: ${failure.message}`;
        if (streak >= MAX_CONSECUTIVE_FAILURES)
          return retire(agent, `${streak} failed sessions in a row; last: ${agent.lastFailure}`);
        const first = retryDelays[failure.kind] ?? retryDelays.error;
        const backoffMs = Math.min(first * 2 ** (streak - 1), 15 * 60_000);
        agent.state = 'backoff';
        await persist();
        onEvent({ event: 'failed', agent: agent.id, ...failure, retryInSeconds: backoffMs / 1000 });
        await delay(backoffMs, runSignal);
        next = 'continue';
        continue;
      }
      streak = 0;
      if (failure?.kind === 'timeout') {
        agent.lastFailure =
          'it reached the session time limit; check git status for unfinished work.';
        next = 'continue';
      } else {
        agent.lastFailure = null;
        agent.lastSummary = result.summary;
        next = result.next;
      }
      await persist();
      onEvent({
        event: 'ended',
        agent: agent.id,
        next,
        summary: agent.lastSummary,
        timedOut: failure?.kind === 'timeout',
        usage: result.usage,
        wallMs: result.wallMs,
      });
    }
  }

  /** Watch the run until it should end; returns once `ended` is set. */
  async function coordinate(system) {
    let quietSince = null,
      seen = run.base.commit,
      lastPoll = 0;
    while (!ended) {
      await delay(TICK_MS, signal);
      if (signal?.aborted) {
        ended = { status: 'stopped', reason: 'interrupted' };
        break;
      }
      const state = await store.read();
      if (state.run?.stopRequested) {
        ended = { status: 'stopped', reason: state.run.stopRequested };
        break;
      }
      if (Date.now() >= Date.parse(run.deadlineAt)) {
        ended = { status: 'expired', reason: 'deadline' };
        break;
      }
      if (Date.now() - lastPoll >= 3000) {
        lastPoll = Date.now();
        for (const commit of await originLog(run.origin, seen).catch(() => [])) {
          seen = commit.commit;
          onEvent({ event: 'push', ...commit });
        }
        for (const message of await system.read({ limit: 200 }).catch(() => []))
          onEvent({ event: 'chat', from: message.from, text: message.text });
      }
      const active = agents.filter((a) => a.state !== 'retired');
      // Agents retire on repeated failures or the session limit, not because the
      // goal is met, so a run without agents never applies its result itself.
      if (!active.length) {
        ended = { status: 'failed', reason: 'every agent retired' };
        break;
      }
      if (!active.every((a) => a.state === 'waiting')) {
        quietSince = null;
        continue;
      }
      quietSince ??= Date.now();
      if (Date.now() - quietSince < config.quietSeconds * 1000) continue;
      quietSince = null;
      await settle(system);
    }
  }

  /** The swarm is quiet: run the checks and either finish or send it back to work. */
  async function settle(system) {
    const commit = await originHead(run.origin);
    const results = await runChecks({ store, run, config, commit });
    run.checkRounds.push({ at: now(), commit, results });
    await persist();
    const failed = results.filter((r) => !r.passed);
    onEvent({ event: 'checks', commit, results });
    if (!failed.length) {
      // Checks can take minutes. If a message woke an agent or main moved
      // meanwhile, the swarm was not done after all.
      const still =
        agents.every((a) => a.state === 'waiting' || a.state === 'retired') &&
        (await originHead(run.origin)) === commit;
      if (still)
        ended = { status: 'finished', reason: 'every agent is waiting and the checks pass' };
      return;
    }
    const failedRounds = run.checkRounds.filter((round) => round.results.some((r) => !r.passed));
    if (failedRounds.length >= config.maxCheckRounds) {
      ended = {
        status: 'failed',
        reason: `checks failed: ${failed.map((r) => r.name).join(', ')}`,
      };
      return;
    }
    await system.send(
      `#${GENERAL}`,
      `Checks failed on main at ${commit.slice(0, 12)} (round ${failedRounds.length} of ${config.maxCheckRounds}):\n${failed
        .map((r) => `- ${r.name}: ${r.error ?? `exit ${r.code}`}\n${r.output.slice(-800)}`)
        .join('\n')}`,
    );
  }

  async function finish(system) {
    run.status = ended.status;
    run.stopReason = ended.reason;
    for (const agent of agents) if (agent.state !== 'retired') agent.state = 'stopped';
    const commit = await originHead(run.origin);
    const commits = (await originLog(run.origin, run.base.commit)).length;
    run.result = { commit, commits, files: [], applied: null, error: null };
    // Keep the swarm's history in the user's repository after .collab/run is replaced.
    await git(run.base.top, [
      'fetch',
      '-q',
      '--no-tags',
      run.origin,
      '+refs/heads/main:refs/model-collab/result',
    ]);
    if (run.status === 'finished' && commit !== run.base.commit) {
      try {
        run.result.applied = await applyResult(store, run);
      } catch (error) {
        run.result.error = error.message;
      }
    }
    run.result.files = run.result.applied ?? (await resultChanges(store, run)).map((c) => c.path);
    await system
      .send(
        `#${GENERAL}`,
        `Run ${run.status}: ${run.stopReason}. Stop working; nothing more will be merged.`,
      )
      .catch(() => {});
    run.endedAt = now();
    await persist();
    onEvent({ event: 'complete', status: run.status, reason: run.stopReason, result: run.result });
  }
}

async function resultChanges(store, run) {
  const filesDir = path.join(store.runDir, 'result', 'files');
  await fs.rm(filesDir, { recursive: true, force: true });
  return commitChanges(run.origin, run.base, run.result.commit, filesDir);
}

async function applyResult(store, run) {
  const changes = await resultChanges(store, run);
  return applyChanges(run.base, changes, path.join(store.runDir, 'result', 'files'));
}

/** Apply the latest run's result to the working tree, whatever its status. */
export async function applyLatest(root) {
  const store = new Store(root);
  const state = await store.read();
  const run = state.run;
  if (!run?.result) throw new Error('No finished run has a result to apply.');
  if (isOpen(run)) throw new Error('The run is still in progress.');
  const applied = await applyResult(store, run);
  await store.update((s) => {
    s.run.result.applied = applied;
    s.run.result.error = null;
  });
  return applied;
}

/** Ask the supervisor to end the run; nothing is applied. */
export async function stopRun(root, reason = 'stopped by the user') {
  const store = new Store(root);
  return store.update(async (state) => {
    if (!isOpen(state.run)) throw new Error('No run is in progress.');
    if (!alive(state.run.supervisorPid)) {
      await closeDeadRun(state.run, 'stopped', `${reason} (the supervisor had already exited)`);
      return state.run;
    }
    state.run.stopRequested = reason;
    return state.run;
  });
}

/** Post the user's instruction to #general, waking every waiting agent. */
export async function noteRun(root, text) {
  const store = new Store(root);
  const state = await store.read();
  if (!isOpen(state.run)) throw new Error('No run is in progress.');
  const tokens = JSON.parse(await fs.readFile(store.tokensFile, 'utf8'));
  const human = new ChatClient({
    command: state.run.chat.command,
    url: state.run.chat.url,
    token: tokens[HUMAN],
  });
  const message = await human.send(`#${GENERAL}`, text);
  await store.update((s) => {
    s.run.notes.push({ at: now(), text });
  });
  return message;
}
