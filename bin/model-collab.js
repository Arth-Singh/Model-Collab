#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Store } from '../src/store.js';
import { configSchema } from '../src/schema.js';
import { renderEvent, renderResult, renderStatus } from '../src/display.js';
import { DEFAULT_MODELS } from '../src/process.js';

const { version } = JSON.parse(
  await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'),
);
const program = new Command()
  .name('model-collab')
  .description('Run a swarm of Claude Code and Codex agents on one goal in your repository.')
  .version(version);
const output = (value) =>
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const withRepo = (command) =>
  command.option('--repo <path>', 'Repository directory', process.cwd());
const count = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Expected a whole number, got ${value}.`);
  return n;
};
function onOff(value) {
  if (!['on', 'off'].includes(value)) throw new Error('Use on or off.');
  return value === 'on';
}
async function textInput(value) {
  if (value === '-') {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    return text;
  }
  return value.startsWith('@') ? fs.readFile(value.slice(1), 'utf8') : value;
}
async function jsonInput(value) {
  return JSON.parse(await textInput(value));
}

/** Options shared by init, configure, and up. */
function settingOptions(command) {
  return command
    .option('--agents <n>', 'Swarm size, split evenly between Claude Code and Codex', count)
    .option('--claude <n>', 'Claude Code agents', count)
    .option('--codex <n>', 'Codex agents', count)
    .option('--claude-model <model>', `Claude model (default ${DEFAULT_MODELS.claude})`)
    .option('--codex-model <model>', `Codex model (default ${DEFAULT_MODELS.codex})`)
    .option('--effort <level>', 'Reasoning effort for both CLIs')
    .option('--codex-service-tier <tier>', 'Codex service tier, such as fast; none for standard')
    .option('--minutes <n>', 'Deadline for the whole run', Number)
    .option('--session-minutes <n>', 'Time limit for one agent session', Number)
    .option('--max-sessions <n>', 'Sessions one agent may start in a run', Number)
    .option('--quiet-seconds <n>', 'How long every agent must wait before the run ends', Number)
    .option('--stagger-seconds <n>', 'Delay between agent starts', Number)
    .option('--checks <json>', 'Named checks as JSON argv arrays, or @file')
    .option('--check-timeout <seconds>', 'Timeout for each check run', Number)
    .option('--max-check-rounds <n>', 'Failed check rounds before the run gives up', Number)
    .option('--dependency-dirs <names>', 'Comma-separated ignored folders to link into clones')
    .option('--pass-env <names>', 'Comma-separated environment variables agents may see')
    .option('--tensorboard <on|off>', 'Write TensorBoard scalars for each run', onOff)
    .option('--tensorboard-dir <dir>', 'Where runs write TensorBoard logs')
    .option('--monitor-seconds <n>', 'How often the TensorBoard scalars are sampled', Number)
    .option('--score <json>', 'Command (JSON argv array) that scores main during a run, or @file')
    .option('--score-seconds <n>', 'How often the score command runs', Number)
    .option('--gpu <json>', 'GPU host agents may start jobs on, as JSON or @file; none removes it')
    .option('--preset <name>', 'coding or research');
}

async function settingChanges(opts, current = {}) {
  const list = (value) =>
    value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const changes = {
    preset: opts.preset,
    claude: opts.claude ?? (opts.agents === undefined ? undefined : Math.ceil(opts.agents / 2)),
    codex: opts.codex ?? (opts.agents === undefined ? undefined : Math.floor(opts.agents / 2)),
    effort: opts.effort,
    codexServiceTier:
      opts.codexServiceTier === undefined
        ? undefined
        : opts.codexServiceTier === 'none'
          ? null
          : opts.codexServiceTier,
    deadlineMinutes: opts.minutes,
    sessionMinutes: opts.sessionMinutes,
    maxSessions: opts.maxSessions,
    quietSeconds: opts.quietSeconds,
    staggerSeconds: opts.staggerSeconds,
    checks: opts.checks === undefined ? undefined : await jsonInput(opts.checks),
    checkTimeoutSeconds: opts.checkTimeout,
    maxCheckRounds: opts.maxCheckRounds,
    dependencyDirs: opts.dependencyDirs === undefined ? undefined : list(opts.dependencyDirs),
    passEnv: opts.passEnv === undefined ? undefined : list(opts.passEnv),
    tensorboard: opts.tensorboard,
    tensorboardDir: opts.tensorboardDir,
    monitorSeconds: opts.monitorSeconds,
    scoreCommand: opts.score === undefined ? undefined : await jsonInput(opts.score),
    scoreSeconds: opts.scoreSeconds,
    gpu:
      opts.gpu === undefined ? undefined : opts.gpu === 'none' ? null : await jsonInput(opts.gpu),
    memory: opts.memory,
  };
  if (opts.claudeModel || opts.codexModel)
    changes.models = {
      ...current.models,
      ...(opts.claudeModel ? { claude: opts.claudeModel } : {}),
      ...(opts.codexModel ? { codex: opts.codexModel } : {}),
    };
  return Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
}

function renderConfig(config) {
  const models = { ...DEFAULT_MODELS, ...config.models };
  return [
    'Project settings',
    `Swarm: ${config.claude} Claude Code (${models.claude}) + ${config.codex} Codex (${models.codex}${config.codexServiceTier ? `, ${config.codexServiceTier} tier` : ''}), effort ${config.effort}`,
    `Limits: ${config.deadlineMinutes} minutes per run, ${config.sessionMinutes} per session, ${config.maxSessions} sessions per agent`,
    `Ends after every agent waits ${config.quietSeconds} seconds and the checks pass (at most ${config.maxCheckRounds} check rounds)`,
    `Checks: ${Object.keys(config.checks).join(', ') || 'none'} (timeout ${config.checkTimeoutSeconds} seconds)`,
    `Linked dependency folders: ${config.dependencyDirs.join(', ') || 'none'}`,
    `Extra environment for agents: ${config.passEnv.join(', ') || 'none'}`,
    `TensorBoard: ${config.tensorboard ? `on, every ${config.monitorSeconds} seconds, in ${config.tensorboardDir ?? '.collab/tensorboard'}` : 'off'}`,
    `Score: ${config.scoreCommand.length ? `${config.scoreCommand.join(' ')}, every ${config.scoreSeconds} seconds` : 'none'}`,
    `GPU host: ${config.gpu ? `${config.gpu.host}, GPUs ${config.gpu.gpus.join(', ')}, at most ${config.gpu.maxMinutes} minutes per job` : 'none'}`,
    `Project memory: ${config.memory ? 'on' : 'off'}`,
  ].join('\n');
}

settingOptions(
  withRepo(
    program
      .command('up')
      .description('Start a run and supervise the swarm until it finishes, expires, or is stopped.')
      .argument('<goal>', 'The goal, or @file, or - for standard input'),
  ),
)
  .option('--criteria <text...>', 'Success criteria')
  .option('--no-memory', 'Do not fold this run into project memory')
  .option('--json', 'Print events and the result as JSON lines')
  .action(async (goalArg, opts) => {
    const { runSwarm } = await import('../src/swarm.js');
    const store = new Store(opts.repo);
    const stored = await store.load();
    const controller = new AbortController();
    let interrupts = 0;
    const interrupt = () => {
      if (++interrupts > 1) process.exit(130);
      console.error('Stopping the swarm; press Ctrl-C again to quit at once.');
      controller.abort();
    };
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    const show = (value) => (opts.json ? console.log(JSON.stringify(value)) : output(value));
    try {
      const overrides = await settingChanges(opts, stored?.config);
      delete overrides.memory;
      const run = await runSwarm({
        root: opts.repo,
        goal: await textInput(goalArg),
        criteria: opts.criteria ?? [],
        overrides,
        signal: controller.signal,
        onEvent: (event) => {
          const line = opts.json ? event : renderEvent(event);
          if (line) show(line);
        },
      });
      show(opts.json ? { event: 'result', run } : renderResult(run));
      if (opts.memory && run.config.memory) {
        const { updateMemory } = await import('../src/memory.js');
        const memory = await updateMemory(path.resolve(opts.repo), {
          agent: run.config.claude ? 'claude' : 'codex',
          effort: 'low',
        }).catch((error) => ({ error: error.message }));
        const message = memory.error
          ? `Project memory was not updated: ${memory.error}`
          : memory.changed
            ? 'Project memory updated: .collab/MEMORY.md'
            : 'Project memory unchanged.';
        show(
          opts.json ? { event: 'memory', ...memory } : renderEvent({ event: 'memory', message }),
        );
      }
      if (run.status !== 'finished') process.exitCode = 1;
    } finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
    }
  });

settingOptions(
  withRepo(
    program
      .command('init')
      .description('Create .collab with project settings, without starting a run.'),
  ),
)
  .option('--no-memory', 'Do not keep project memory across runs')
  .option('--json', 'Print the settings as JSON')
  .action(async (opts) => {
    const state = await new Store(opts.repo).init(await settingChanges(opts));
    output(
      opts.json
        ? state.config
        : `${renderConfig(state.config)}\n\nShared context for every agent: .collab/CONTEXT.md\nStart a run with model-collab up "Your goal".`,
    );
  });

settingOptions(
  withRepo(program.command('configure').description('Change project settings for later runs.')),
)
  .option('--memory <on|off>', 'Keep project memory across runs', onOff)
  .option('--json', 'Print the settings as JSON')
  .action(async (opts) => {
    const store = new Store(opts.repo);
    const current = await store.read();
    const changes = await settingChanges(opts, current.config);
    const state = Object.keys(changes).length ? await store.configure(changes) : current;
    const config = configSchema.parse(state.config);
    output(opts.json ? config : renderConfig(config));
  });

withRepo(program.command('status').description('Show the latest run: agents, commits, and result.'))
  .option('--json', 'Print the state as JSON')
  .action(async (opts) => {
    const state = await new Store(opts.repo).read();
    output(opts.json ? state : renderStatus(state));
  });

withRepo(
  program
    .command('note')
    .description('Post an instruction to #general as the user; it wakes every waiting agent.')
    .argument('<text>', 'The instruction, or @file, or - for standard input'),
).action(async (text, opts) => {
  const { noteRun } = await import('../src/swarm.js');
  const message = await noteRun(opts.repo, await textInput(text));
  output(`Posted to #general as ${message.from}.`);
});

withRepo(
  program
    .command('stop')
    .description('End the run. Nothing is applied; the result stays available to apply.')
    .argument('[reason]', 'Why the run is stopped'),
).action(async (reason, opts) => {
  const { stopRun } = await import('../src/swarm.js');
  const run = await stopRun(opts.repo, reason);
  output(
    run.stopRequested
      ? 'Stop requested; the supervisor ends the run within a few seconds.'
      : `Run marked ${run.status}: ${run.stopReason}`,
  );
});

withRepo(
  program.command('apply').description("Apply the latest run's final commit to your working tree."),
).action(async (opts) => {
  const { applyLatest } = await import('../src/swarm.js');
  const files = await applyLatest(opts.repo);
  output(`Applied to your working tree: ${files.join(', ') || 'no file changes'}.`);
});

withRepo(program.command('view').description('Watch every chat of the swarm in your browser.'))
  .option('--no-open', 'Print the address instead of opening a browser')
  .action(async (opts) => {
    const store = new Store(opts.repo);
    const state = await store.read();
    const command = state.run?.chat?.command ?? state.config.chatCommand;
    const args = ['view', '--data', store.chatDir, ...(opts.open ? [] : ['--no-open'])];
    const child = spawn(command, args, { stdio: 'inherit' });
    process.exitCode = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code) => resolve(code ?? 1));
    });
  });

withRepo(
  program
    .command('tensorboard')
    .description("Open TensorBoard on every run's scalars: commits, tokens, agents, chat, score."),
)
  .option('--port <n>', 'Port for TensorBoard', '6006')
  .option('--host <host>', 'Address TensorBoard listens on', '127.0.0.1')
  .action(async (opts) => {
    const { tensorboardDir } = await import('../src/monitor.js');
    const store = new Store(opts.repo);
    const { config } = await store.read();
    const dir = tensorboardDir(store.root, config);
    await fs.mkdir(dir, { recursive: true });
    const child = spawn(
      'tensorboard',
      ['--logdir', dir, '--port', opts.port, '--host', opts.host],
      {
        stdio: 'inherit',
      },
    );
    process.exitCode = await new Promise((resolve, reject) => {
      child.on('error', (error) =>
        reject(
          new Error(
            `Could not start tensorboard (${error.message}). Install it with: uv tool install tensorboard`,
          ),
        ),
      );
      child.on('exit', (code) => resolve(code ?? 1));
    });
  });

withRepo(
  program
    .command('transcript')
    .description('Print every chat message of the latest run, oldest first.'),
)
  .option('--json', 'Print JSON lines')
  .action(async (opts) => {
    const { readTranscript } = await import('../src/chat.js');
    const store = new Store(opts.repo);
    const { run } = await store.read();
    if (!run) throw new Error('No run yet.');
    const messages = await readTranscript(store.chatDir, {
      since: run.createdAt,
      until: run.endedAt ?? undefined,
    });
    for (const m of messages)
      console.log(
        opts.json ? JSON.stringify(m) : `[${m.at.slice(11, 19)}] ${m.chat} ${m.from}: ${m.text}`,
      );
  });

withRepo(program.command('doctor').description('Check local requirements without starting agents.'))
  .option('--json', 'Print structured check results')
  .action(async (opts) => {
    const { doctor, renderDoctor } = await import('../src/doctor.js');
    const result = await doctor({ root: opts.repo });
    output(opts.json ? result : renderDoctor(result));
    if (!result.ok) process.exitCode = 1;
  });

const memory = program
  .command('memory')
  .description('Show, update, or clear the project memory that carries over between runs.');
withRepo(memory.command('show').description('Print .collab/MEMORY.md.')).action(async (opts) => {
  const file = path.join(path.resolve(opts.repo), '.collab', 'MEMORY.md');
  const text = await fs.readFile(file, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  output(text ?? 'No project memory yet. It is written when a run ends.');
});
withRepo(
  memory
    .command('update')
    .description('Fold finished runs into project memory now, with one model call per run.'),
)
  .option('--agent <id>', 'codex or claude', 'claude')
  .option('--model <model>', 'Model for the update')
  .option('--effort <level>', 'Reasoning effort', 'low')
  .option('--json', 'Print JSON')
  .action(async (opts) => {
    if (!['codex', 'claude'].includes(opts.agent))
      throw new Error('Agent must be codex or claude.');
    const { updateMemory } = await import('../src/memory.js');
    const result = await updateMemory(path.resolve(opts.repo), {
      agent: opts.agent,
      model: opts.model ?? DEFAULT_MODELS[opts.agent],
      effort: opts.effort,
    });
    output(
      opts.json
        ? result
        : result.disabled
          ? 'Project memory is off. Turn it on with model-collab configure --memory on.'
          : [
              result.consolidated.length
                ? `Remembered ${result.consolidated.length} run(s)${result.changed ? '; .collab/MEMORY.md changed' : '; nothing durable to add'}.`
                : 'No finished runs to remember.',
              ...(result.skipped.length
                ? [
                    `Skipped ${result.skipped.length} older run(s); an update remembers at most the three most recent.`,
                  ]
                : []),
            ].join('\n'),
    );
  });
withRepo(
  memory
    .command('clear')
    .description('Delete the project memory. Run history and the chat are kept.'),
).action(async (opts) => {
  const { clearMemory } = await import('../src/memory.js');
  await clearMemory(path.resolve(opts.repo));
  output('Project memory cleared.');
});

withRepo(
  program
    .command('serve')
    .description("Run one agent's MCP server (started by the agent's CLI during a run)."),
)
  .requiredOption('--agent <id>', 'The agent this server speaks for')
  .action(async (opts) => {
    const { serve } = await import('../src/server.js');
    await serve(path.resolve(opts.repo), opts.agent);
  });

try {
  await program.parseAsync();
} catch (error) {
  console.error(`model-collab: ${error.message}`);
  process.exitCode = 1;
}
