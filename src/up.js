import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import lockfile from 'proper-lockfile';
import { Collaboration } from './core.js';
import { configSchema, startSchema, sessionIdSchema } from './schema.js';
import { binPath, writeInstructions } from './setup.js';
import { runCommand } from './process.js';
import { runWorker } from './worker.js';

const SOCKET = 'model-collab';
const digest = (text) => createHash('sha256').update(text).digest('hex').slice(0, 10);
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const openSession = (session) => ['active', 'paused'].includes(session?.status);

/** Pure inspection: no mkdir, locks, expiry writes, or subprocesses. */
export async function planUp({
  root = process.cwd(),
  goal,
  preset,
  ui = 'tmux',
  models = {},
  effort = 'xhigh',
  checks,
  minutes = 30,
  maxRounds = 4,
  maxMessages = 24,
  criteria = [],
} = {}) {
  root = await fs.realpath(root);
  const task = startSchema.parse({ topic: goal, successCriteria: criteria });
  if (!['tmux', 'workers'].includes(ui)) throw new Error('UI must be tmux or workers.');
  let existing = null;
  try {
    existing = JSON.parse(await fs.readFile(path.join(root, '.collab', 'state.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (existing && existing.schemaVersion !== 1) throw new Error('Unsupported state version.');
  const config = existing
    ? configSchema.parse(existing.config)
    : configSchema.parse({
        participants: ['codex', 'claude'],
        preset: preset ?? 'coding',
        deadlineMinutes: minutes,
        maxRounds,
        maxMessages,
        checks: checks ?? {},
      });
  if (preset && config.preset !== preset)
    throw new Error(`Repository already uses preset ${config.preset}; omit --preset to keep it.`);
  if (checks && existing && JSON.stringify(checks) !== JSON.stringify(config.checks))
    throw new Error(
      'Existing checks are preserved; initialize a separate project to use different checks.',
    );
  if (
    !config.participants.includes('codex') ||
    !config.participants.includes('claude') ||
    config.participants.length !== 2
  )
    throw new Error('Automatic startup requires exactly codex and claude participants.');
  const expired =
    existing?.session?.status === 'active' && Date.parse(existing.session.deadlineAt) <= Date.now();
  if (!expired && openSession(existing?.session) && existing.session.topic !== task.topic)
    throw new Error(
      'A different goal is active or paused. Stop it explicitly before starting a new goal.',
    );
  return {
    root,
    task,
    config,
    ui,
    models: {
      codex: models.codex ?? 'gpt-6-astra',
      claude: models.claude ?? 'claude-fable-5-1[1m]',
    },
    effort,
    initialized: Boolean(existing),
    existingSession: existing?.session?.id ?? null,
    paused: existing?.session?.status === 'paused',
    action: expired || !openSession(existing?.session) ? 'start' : 'reuse',
  };
}

/** Create only package-owned tmux resources; never inject input into existing panes. */
export async function startTmux({ root, sessionId, models, effort, run, paneCommands }) {
  const sessionName = `mc-${digest(root)}-${sessionId.slice(0, 8)}`;
  const owner = `${root}\n${sessionId}`;
  const execute = run ?? ((argv) => runCommand(['tmux', ...argv], { cwd: root, timeoutMs: 10000 }));
  const call = async (args, optional = false) => {
    // tmux has its own command parser even with direct argv. A trailing semicolon
    // must be escaped once for tmux (there is no intervening shell).
    const escaped = ['-L', SOCKET, ...args].map((value) =>
      value.endsWith(';') ? value.slice(0, -1) + '\\;' : value,
    );
    const result = await execute(escaped);
    if (!optional && (result.code !== 0 || result.error))
      throw new Error(`tmux failed: ${result.error ?? result.stderr?.trim() ?? result.code}`);
    return result;
  };
  const attach = ['tmux', '-L', SOCKET, 'attach-session', '-t', sessionName];
  const existing = await call(['has-session', '-t', sessionName], true);
  if (existing.code === 0) {
    const marker = await call(['show-options', '-qv', '-t', sessionName, '@model_collab_owner']);
    if (marker.stdout.trim() !== owner)
      throw new Error(
        'A tmux session with this name exists but is not owned by this collaboration.',
      );
    return {
      sessionName,
      sessionId,
      reused: true,
      attach,
      attachCommand: attach.map(quote).join(' '),
    };
  }
  if (existing.error || ![1].includes(existing.code))
    throw new Error(`Cannot inspect tmux: ${existing.error ?? existing.stderr}`);
  let created = false;
  try {
    const control = [process.execPath, binPath, 'control', '--repo', root, '--session', sessionId];
    // tmux executes multiple shell-command arguments directly, without a shell.
    await call([
      'new-session',
      '-d',
      '-s',
      sessionName,
      '-n',
      'control',
      '-x',
      '180',
      '-y',
      '48',
      '-c',
      root,
      ...control,
    ]);
    created = true;
    await call(['set-option', '-t', sessionName, '@model_collab_owner', owner]);
    const commandFor = (agent) =>
      paneCommands?.[agent] ?? [
        process.execPath,
        binPath,
        'launch',
        '--repo',
        root,
        '--agent',
        agent,
        '--session',
        sessionId,
        '--model',
        models[agent],
        '--effort',
        effort,
      ];
    const first = await call([
      'new-window',
      '-d',
      '-P',
      '-F',
      '#{pane_id}',
      '-t',
      sessionName,
      '-n',
      'peers',
      '-c',
      root,
      ...commandFor('claude'),
    ]);
    const firstPane = first.stdout.trim();
    if (!/^%\d+$/.test(firstPane)) throw new Error('tmux returned an invalid pane ID.');
    await call(['set-window-option', '-t', firstPane, 'remain-on-exit', 'on']);
    await call(['split-window', '-h', '-t', firstPane, '-c', root, ...commandFor('codex')]);
    await call(['select-window', '-t', firstPane]);
    const result = {
      sessionName,
      sessionId,
      reused: false,
      attach,
      attachCommand: attach.map(quote).join(' '),
    };
    await fs.writeFile(
      path.join(root, '.collab', 'terminal.json'),
      JSON.stringify(result, null, 2) + '\n',
      { mode: 0o600 },
    );
    return result;
  } catch (error) {
    if (created) await call(['kill-session', '-t', sessionName], true).catch(() => {});
    throw error;
  }
}

export async function up(options = {}) {
  const preview = await planUp(options);
  if (options.print) return { dryRun: true, ...preview };
  if (preview.ui === 'tmux' && !options.runTmux) {
    const check = await runCommand(['tmux', '-V'], { timeoutMs: 5000 });
    if (check.code !== 0 || check.error)
      throw new Error(
        'tmux is required for visible automatic startup. Install tmux, or choose --ui workers.',
      );
  }
  if (!options.runTmux && !options.paneCommands && !options.turn) {
    for (const command of ['codex', 'claude']) {
      const check = await runCommand([command, '--version'], { timeoutMs: 10000 });
      if (check.code !== 0 || check.error)
        throw new Error(
          `${command} CLI is unavailable. Install and authenticate it before automatic startup.`,
        );
    }
  }
  // A separate lock serializes startup across init, goal creation, and pane launch.
  const directory = path.join(preview.root, '.collab');
  await fs.mkdir(directory, { recursive: true });
  const release = await lockfile.lock(path.join(directory, 'startup'), {
    realpath: false,
    retries: { retries: 30, minTimeout: 20, maxTimeout: 100 },
    stale: 10000,
  });
  let result, plan;
  try {
    plan = await planUp(options);
    const collab = new Collaboration(plan.root);
    if (!plan.initialized) await collab.init(plan.config);
    await writeInstructions(plan.root, plan.config.participants, { preset: plan.config.preset });
    let state = await collab.status();
    if (!openSession(state.session)) state = await collab.start(plan.task);
    if (state.session.status === 'paused') {
      if (!options.resume)
        return {
          status: 'paused',
          root: plan.root,
          sessionId: state.session.id,
          next: 'Use --resume only when ready to resume this goal.',
        };
      state = await collab.resume();
    }
    result = {
      root: plan.root,
      sessionId: state.session.id,
      preset: plan.config.preset,
      ui: plan.ui,
    };
    if (plan.ui === 'tmux')
      result = {
        ...result,
        ...(await startTmux({
          ...plan,
          sessionId: state.session.id,
          run: options.runTmux,
          paneCommands: options.paneCommands,
        })),
      };
  } finally {
    await release();
  }
  if (plan.ui === 'workers') {
    const releasePair = await lockfile.lock(path.join(directory, 'worker-pair'), {
      realpath: false,
      retries: 0,
      stale: 10000,
    });
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
      const outcomes = await Promise.allSettled(
        ['codex', 'claude'].map((agent) =>
          runWorker({
            root: plan.root,
            agent,
            model: plan.models[agent],
            effort: plan.effort,
            timeoutMs: options.timeoutMs ?? 120000,
            signal: controller.signal,
            onEvent: options.onEvent,
            turn: options.turn,
          }).catch((error) => {
            controller.abort();
            throw error;
          }),
        ),
      );
      const failed = outcomes.find((outcome) => outcome.status === 'rejected');
      if (failed) throw failed.reason;
      const peers = outcomes.map((outcome) => outcome.value);
      return { ...result, peers };
    } finally {
      controller.abort();
      options.signal?.removeEventListener('abort', abort);
      await releasePair();
    }
  }
  return result;
}

export async function attachTerminal(result) {
  const child = spawn(result.attach[0], result.attach.slice(1), { stdio: 'inherit', shell: false });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

export async function findTerminal({ root = process.cwd(), run = runCommand } = {}) {
  root = await fs.realpath(root);
  let terminal, state;
  try {
    terminal = JSON.parse(await fs.readFile(path.join(root, '.collab', 'terminal.json'), 'utf8'));
    state = JSON.parse(await fs.readFile(path.join(root, '.collab', 'state.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new Error('No terminal session recorded. Run model-collab up "Your goal" first.');
    throw error;
  }
  const sessionId = sessionIdSchema.parse(state.session?.id);
  const sessionName = `mc-${digest(root)}-${sessionId.slice(0, 8)}`;
  if (terminal.sessionId !== sessionId || terminal.sessionName !== sessionName) {
    throw new Error(
      'The recorded terminal belongs to an earlier goal. Run model-collab up with the current goal.',
    );
  }
  const present = await run(['tmux', '-L', SOCKET, 'has-session', '-t', sessionName], {
    timeoutMs: 5000,
  });
  if (present.code !== 0 || present.error)
    throw new Error(
      'The terminal session has closed. Run model-collab up with the current goal to reopen it.',
    );
  const marker = await run(
    ['tmux', '-L', SOCKET, 'show-options', '-qv', '-t', sessionName, '@model_collab_owner'],
    { timeoutMs: 5000 },
  );
  if (marker.code !== 0 || marker.error || marker.stdout.trim() !== `${root}\n${sessionId}`) {
    throw new Error('The terminal session is not owned by this collaboration.');
  }
  const attach = ['tmux', '-L', SOCKET, 'attach-session', '-t', sessionName];
  return { root, sessionName, sessionId, attach, attachCommand: attach.map(quote).join(' ') };
}
