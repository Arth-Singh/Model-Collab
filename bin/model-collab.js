#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Collaboration } from '../src/core.js';
import { configSchema, sessionIdSchema } from '../src/schema.js';
import { launch, serverConfig, writeInstructions } from '../src/setup.js';
import {
  renderBoardPosts,
  renderBoardThreads,
  renderStartup,
  renderStatus,
  renderWorkerEvent,
} from '../src/display.js';
import { DEFAULT_EFFORT, DEFAULT_MODELS } from '../src/native.js';
import { DEFAULT_TURN_TIMEOUT_MS } from '../src/worker.js';

const { version } = JSON.parse(
  await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'),
);
const program = new Command()
  .name('model-collab')
  .description('Run Codex and Claude Code together in your repository.')
  .version(version);
const output = (value) =>
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const withRepo = (command) =>
  command.option('--repo <path>', 'Repository directory', process.cwd());
const core = (options) => new Collaboration(options.repo);
const list = (value) =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
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
  if (value === '-') {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    return JSON.parse(text);
  }
  return JSON.parse(value.startsWith('@') ? await fs.readFile(value.slice(1), 'utf8') : value);
}

withRepo(
  program
    .command('up')
    .description(
      'Start a goal and launch both agents in tmux panes, or unattended with --ui workers.',
    )
    .argument('<goal>'),
)
  .option('--preset <name>', 'coding (new projects) or research')
  .option('--ui <mode>', 'tmux or workers', 'tmux')
  .option('--detach', 'Start native panes without attaching this terminal')
  .option('--print', 'Show a plan without modifying files or starting processes')
  .option('--json', 'Print structured startup information and worker events')
  .option('--resume', 'Explicitly resume the same paused goal')
  .option('--minutes <n>', 'New-project session deadline', Number, 30)
  .option('--max-rounds <n>', 'New-project discussion round cap', Number, 3)
  .option('--max-messages <n>', 'New-project message cap', Number, 24)
  .option('--checks <json>', 'New-project named checks as argv arrays, or @file')
  .option('--check-timeout <seconds>', 'New-project timeout for each check run', Number)
  .option('--no-memory', 'New project: do not keep project memory across goals')
  .option('--criteria <text...>', 'Success criteria')
  .option('--effort <level>', 'Reasoning effort', DEFAULT_EFFORT)
  .option('--turn-timeout <seconds>', 'Workers: time limit for one model turn', Number, 900)
  .option('--codex-model <model>', 'Codex model', DEFAULT_MODELS.codex)
  .option('--claude-model <model>', 'Claude model', DEFAULT_MODELS.claude)
  .action(async (goal, opts) => {
    const { up, attachTerminal } = await import('../src/up.js');
    const controller = new AbortController(),
      interrupt = () => controller.abort();
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    try {
      const result = await up({
        root: opts.repo,
        goal,
        preset: opts.preset,
        ui: opts.ui,
        print: opts.print,
        resume: opts.resume,
        minutes: opts.minutes,
        maxRounds: opts.maxRounds,
        maxMessages: opts.maxMessages,
        checks: opts.checks ? await jsonInput(opts.checks) : undefined,
        checkTimeoutSeconds: opts.checkTimeout,
        memory: opts.memory,
        criteria: opts.criteria,
        effort: opts.effort,
        timeoutMs: opts.turnTimeout * 1000,
        models: { codex: opts.codexModel, claude: opts.claudeModel },
        signal: controller.signal,
        onEvent: (event) => {
          const message = opts.json ? event : renderWorkerEvent(event);
          if (message) output(message);
        },
      });
      output(opts.print || opts.json ? result : renderStartup(result, goal));
      if (
        result.attach &&
        !opts.detach &&
        process.stdin.isTTY &&
        process.stdout.isTTY &&
        !process.env.TMUX
      )
        process.exitCode = await attachTerminal(result);
    } finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
    }
  });

withRepo(program.command('doctor').description('Check local requirements without starting agents.'))
  .option('--json', 'Print structured check results')
  .action(async (opts) => {
    const { doctor, renderDoctor } = await import('../src/doctor.js');
    const result = await doctor({ root: opts.repo });
    output(opts.json ? result : renderDoctor(result));
    if (!result.ok) process.exitCode = 1;
  });

withRepo(
  program
    .command('configure')
    .description('Update settings for the next goal after the current session stops.'),
)
  .option('--preset <name>', 'coding or research')
  .option('--minutes <n>', 'Conversation time limit', Number)
  .option('--max-rounds <n>', 'Discussion round limit', Number)
  .option('--max-messages <n>', 'Contribution limit', Number)
  .option('--check-timeout <seconds>', 'Timeout for each check run', Number)
  .option(
    '--dependency-dirs <names>',
    'Comma-separated ignored directories to link into worktrees',
    list,
  )
  .option('--memory <on|off>', 'Keep project memory across goals', onOff)
  .option('--checks <json>', 'Named verification commands as JSON, or @file')
  .option('--json', 'Print the saved configuration as JSON')
  .action(async (opts) => {
    const changes = Object.fromEntries(
      Object.entries({
        preset: opts.preset,
        deadlineMinutes: opts.minutes,
        maxRounds: opts.maxRounds,
        maxMessages: opts.maxMessages,
        checkTimeoutSeconds: opts.checkTimeout,
        dependencyDirs: opts.dependencyDirs,
        memory: opts.memory,
        checks: opts.checks === undefined ? undefined : await jsonInput(opts.checks),
      }).filter(([, value]) => value !== undefined),
    );
    const state = Object.keys(changes).length
      ? await core(opts).configure(changes)
      : await core(opts).status();
    if (Object.keys(changes).length)
      await writeInstructions(path.resolve(opts.repo), state.config.participants, {
        preset: state.config.preset,
      });
    // Parsing fills defaults for settings added after the project was initialized.
    const config = configSchema.parse(state.config);
    output(
      opts.json
        ? config
        : `Project settings\nPreset: ${config.preset}\nLimits: ${config.maxRounds} rounds, ${config.maxMessages} contributions, ${config.deadlineMinutes} minutes\nChecks: ${Object.keys(config.checks).join(', ') || 'none'} (timeout ${config.checkTimeoutSeconds} seconds)\nLinked dependency directories: ${config.dependencyDirs.join(', ') || 'none'}\nProject memory: ${config.memory ? 'on' : 'off'}\nThese settings apply to new goals.`,
    );
  });

withRepo(
  program.command('attach').description("Return to this project's existing terminal session."),
)
  .option('--print', 'Print attach information without opening the terminal')
  .action(async (opts) => {
    const { findTerminal, attachTerminal } = await import('../src/up.js');
    const terminal = await findTerminal({ root: opts.repo });
    if (opts.print) output(terminal);
    else if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.TMUX)
      output(`Run this from a terminal outside tmux:\n${terminal.attachCommand}`);
    else process.exitCode = await attachTerminal(terminal);
  });

withRepo(
  program
    .command('init')
    .description(
      'Initialize repository-local state and peer prompts; preserve existing instructions.',
    ),
)
  .option('--preset <name>', 'coding or research', 'coding')
  .option('--participants <ids>', 'Comma-separated peer IDs', 'codex,claude')
  .option('--max-rounds <n>', 'Discussion rounds after independent proposals', Number, 3)
  .option('--max-messages <n>', 'Hard cap on contributions', Number, 24)
  .option('--minutes <n>', 'Wall-clock session limit', Number, 30)
  .option('--check-timeout <seconds>', 'Timeout for each check run', Number, 300)
  .option(
    '--dependency-dirs <names>',
    'Comma-separated ignored directories to link into worktrees',
    list,
  )
  .option('--no-memory', 'Do not keep project memory across goals')
  .option('--checks <json>', 'JSON object of check names to argv arrays, or @file', '{}')
  .option('--json', 'Print initialized project settings as JSON')
  .action(async (opts) => {
    const state = await core(opts).init({
      preset: opts.preset,
      participants: list(opts.participants),
      maxRounds: opts.maxRounds,
      maxMessages: opts.maxMessages,
      deadlineMinutes: opts.minutes,
      checkTimeoutSeconds: opts.checkTimeout,
      dependencyDirs: opts.dependencyDirs,
      memory: opts.memory,
      checks: await jsonInput(opts.checks),
    });
    await writeInstructions(path.resolve(opts.repo), state.config.participants, {
      preset: state.config.preset,
    });
    const result = {
      initialized: path.resolve(opts.repo),
      config: state.config,
      next: 'Run model-collab up "Your goal" from this project to start both agents.',
    };
    output(
      opts.json
        ? result
        : `Project ready: ${result.initialized}\nShared context: .collab/CONTEXT.md${state.config.preset === 'research' ? '\nResearch brief: .collab/RESEARCH.md' : ''}\n${result.next}`,
    );
  });

withRepo(
  program
    .command('start')
    .argument('<goal>')
    .description('Start a goal without launching agents; each peer joins with launch or worker.'),
)
  .option('--criteria <text...>', 'Success criteria')
  .option('--json', 'Print session state as JSON')
  .action(async (goal, opts) => {
    const state = await core(opts).start({ topic: goal, successCriteria: opts.criteria ?? [] });
    output(opts.json ? state : renderStatus(state));
  });
withRepo(
  program
    .command('status')
    .description('Print the session state as JSON, or a summary with --human.'),
)
  .option('--agent <id>', 'Peer-filtered view')
  .option('--human', 'Show a readable session summary')
  .action(async (opts) => {
    const state = await core(opts).status(opts.agent);
    output(opts.human ? renderStatus(state) : state);
  });
withRepo(program.command('post').description("Send a peer's protocol message."))
  .requiredOption('--agent <id>')
  .requiredOption(
    '--session <id>',
    'Session UUID from the status used to prepare this contribution',
  )
  .requiredOption('--json <value>', 'JSON message, @file, or - for stdin')
  .action(async (opts) => {
    const sessionId = sessionIdSchema.parse(opts.session);
    output(await core(opts).post(opts.agent, await jsonInput(opts.json), { sessionId }));
  });
withRepo(
  program
    .command('wait')
    .description('Wait up to 25 seconds for the session to move past a revision.'),
)
  .requiredOption('--agent <id>')
  .requiredOption('--after <revision>', 'Last observed revision', Number)
  .option('--timeout <ms>', 'Maximum 25000 ms', Number, 25000)
  .action(async (opts) => output(await core(opts).wait(opts.agent, opts.after, opts.timeout)));
withRepo(program.command('diff').description("Show a candidate's changes as a unified diff."))
  .requiredOption('--agent <id>')
  .requiredOption('--candidate <id>')
  .action(async (opts) =>
    process.stdout.write((await core(opts).diff(opts.agent, opts.candidate)).diff),
  );
withRepo(
  program
    .command('checkout')
    .description('Create a runnable copy of a candidate for review and print its path.'),
)
  .requiredOption('--agent <id>')
  .requiredOption('--candidate <id>')
  .action(async (opts) => output(await core(opts).checkout(opts.agent, opts.candidate)));
withRepo(
  program
    .command('apply')
    .description(
      'Apply the agreed candidate, or one you choose, to your working tree after the session ends.',
    ),
)
  .option('--candidate <id>', 'Candidate to apply instead of the agreed one')
  .option('--json', 'Print the result as JSON')
  .action(async (opts) => {
    const applied = await core(opts).apply(opts.candidate);
    output(
      opts.json
        ? applied
        : `Applied ${applied.candidate}: ${applied.files.join(', ') || 'no file changes'}.`,
    );
  });
withRepo(
  program
    .command('verify')
    .description('Run a configured check against a candidate in a clean checkout.'),
)
  .requiredOption('--agent <id>')
  .requiredOption('--candidate <id>')
  .requiredOption('--check <name>')
  .action(async (opts) => output(await core(opts).verify(opts.agent, opts.candidate, opts.check)));
withRepo(program.command('stop').description('Stop the current session without applying anything.'))
  .option('--reason <text>', 'Stop reason', 'Stopped by user')
  .option('--json', 'Print session state as JSON')
  .action(async (opts) => {
    const state = await core(opts).stop(opts.reason);
    output(opts.json ? state : 'Collaboration stopped. Native panes remain open for inspection.');
  });
withRepo(program.command('pause').description('Pause protocol actions so the user can intervene.'))
  .option('--json', 'Print session state as JSON')
  .action(async (opts) => {
    const state = await core(opts).pause();
    output(
      opts.json
        ? state
        : 'Collaboration paused. Interrupt any ongoing native edit in its own pane before editing the same files.',
    );
  });
withRepo(
  program
    .command('resume')
    .description('Resume a paused session and extend its deadline by the paused duration.'),
)
  .option('--json', 'Print session state as JSON')
  .action(async (opts) => {
    const state = await core(opts).resume();
    output(
      opts.json ? state : 'Collaboration resumed. Tell idle agents to "continue collaboration".',
    );
  });
withRepo(
  program
    .command('note')
    .description('Share a user correction with both peers and invalidate prior votes/checks.')
    .argument('<text>'),
)
  .option('--json', 'Print session state as JSON')
  .action(async (text, opts) => {
    const state = await core(opts).note(text);
    output(
      opts.json
        ? state
        : 'Instruction shared with both agents. Previous votes and checks have been cleared.',
    );
  });
withRepo(
  program
    .command('await-turn')
    .description(
      'Wait locally until this peer can contribute; suitable for interactive agent shell tools.',
    ),
)
  .requiredOption('--agent <id>')
  .option('--timeout <ms>', 'Maximum 300000 ms', Number, 300000)
  .action(async (opts) => output(await core(opts).awaitTurn(opts.agent, opts.timeout)));
const board = program
  .command('board')
  .description('Read and write the project board, which keeps findings across goals.');
const viewerOption = (command) =>
  withRepo(command)
    .option('--agent <id>', 'Read as this peer (sealed peer posts stay hidden); default: you')
    .option('--json', 'Print JSON');
withRepo(
  board
    .command('post')
    .description('Post to the board.')
    .argument('<text>', 'Text, @file, or - for stdin'),
)
  .option('--channel <name>', 'Start a thread in this channel')
  .option('--thread <id>', "Reply to this thread's first post")
  .option('--agent <id>', 'Post as this peer; default: user')
  .option('--request-id <id>', 'Retry-safe identifier for this post')
  .option('--json', 'Print JSON')
  .action(async (text, opts) => {
    const result = await core(opts).boardPost(opts.agent ?? 'user', {
      text: await textInput(text),
      channel: opts.channel,
      thread: opts.thread,
      requestId: opts.requestId,
    });
    output(opts.json ? result : `Posted ${result.post.id} in #${result.post.channel}.`);
  });
viewerOption(board.command('search').description('Search posts, newest first.').argument('[query]'))
  .option('--channel <name>')
  .option('--author <id>')
  .option('--after <id>', 'Only posts after this post')
  .option('--limit <n>', 'Maximum results', Number, 20)
  .option('--cursor <cursor>')
  .action(async (query, opts) => {
    const result = await core(opts).boardSearch(opts.agent, {
      query,
      channel: opts.channel,
      author: opts.author,
      after: opts.after,
      limit: opts.limit,
      cursor: opts.cursor,
      maxChars: 4000,
    });
    output(opts.json ? result : renderBoardPosts(result));
  });
viewerOption(board.command('threads').description('List threads, most recently active first.'))
  .option('--channel <name>')
  .option('--sort <order>', 'activity or created', 'activity')
  .option('--limit <n>', 'Maximum results', Number, 20)
  .option('--cursor <cursor>')
  .action(async (opts) => {
    const result = await core(opts).boardThreads(opts.agent, {
      channel: opts.channel,
      sort: opts.sort,
      limit: opts.limit,
      cursor: opts.cursor,
    });
    output(opts.json ? result : renderBoardThreads(result));
  });
viewerOption(
  board.command('read').description('Read a post; for a thread, its replies too.').argument('<id>'),
).action(async (id, opts) => {
  const collab = core(opts);
  const post = await collab.boardReadPost(opts.agent, { post: id });
  const thread =
    post.thread === post.id
      ? await collab.boardReadThread(opts.agent, { thread: id, limit: 50, maxChars: 4000 })
      : null;
  if (opts.json) output({ post, replies: thread?.replies ?? null });
  else
    output(
      [
        renderBoardPosts({ results: [post] }),
        ...(thread?.replies.results.length ? [renderBoardPosts(thread.replies)] : []),
      ].join('\n\n'),
    );
});

const memory = program
  .command('memory')
  .description('Show, update, or clear the project memory that carries over between goals.');
withRepo(memory.command('show').description('Print .collab/MEMORY.md.')).action(async (opts) => {
  const file = path.join(path.resolve(opts.repo), '.collab', 'MEMORY.md');
  const text = await fs.readFile(file, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  output(text ?? 'No project memory yet. It is written when a goal ends.');
});
withRepo(
  memory
    .command('update')
    .description('Fold finished goals into project memory now, with one model call per goal.'),
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
                ? `Remembered ${result.consolidated.length} goal(s)${result.changed ? '; .collab/MEMORY.md changed' : '; nothing durable to add'}.`
                : 'No finished goals to remember.',
              ...(result.skipped.length
                ? [
                    `Skipped ${result.skipped.length} older goal(s); an update remembers at most the three most recent.`,
                  ]
                : []),
            ].join('\n'),
    );
  });
withRepo(
  memory
    .command('clear')
    .description('Delete the project memory. Goal history and the board are kept.'),
).action(async (opts) => {
  const { clearMemory } = await import('../src/memory.js');
  await clearMemory(path.resolve(opts.repo));
  output('Project memory cleared.');
});

withRepo(program.command('export').description('Print the conversation as JSONL or Markdown.'))
  .option('--format <type>', 'jsonl or markdown', 'jsonl')
  .action(async (opts) => {
    if (!['jsonl', 'markdown'].includes(opts.format))
      throw new Error('Format must be jsonl or markdown.');
    process.stdout.write(await core(opts).transcript(opts.format));
  });
withRepo(
  program.command('serve').description('Run stdio MCP server with a fixed participant identity.'),
)
  .requiredOption('--agent <id>')
  .option(
    '--worker-tools',
    'Expose only status, review, verification, and board tools, without posting or lifecycle tools',
  )
  .option('--no-contract', 'Omit the peer contract from server instructions')
  .action(async (opts) => {
    const { serve } = await import('../src/server.js');
    await serve(opts.repo, opts.agent, opts);
  });
withRepo(
  program.command('refresh').description('Regenerate README and JSONL views from canonical state.'),
).action(async (opts) => output(await core(opts).refreshViews()));
withRepo(
  program
    .command('config')
    .description('Print per-client MCP config without changing global settings.'),
)
  .requiredOption('--agent <id>')
  .action(async (opts) =>
    output({ mcpServers: { model_collab: serverConfig(opts.repo, opts.agent) } }),
  );
withRepo(
  program
    .command('launch')
    .description('Launch interactive Codex or Claude in this terminal, with collaboration tools.'),
)
  .requiredOption('--agent <id>')
  .option('--session <id>', 'Expected collaboration session')
  .option('--model <model>', 'Model override')
  .option('--effort <level>', 'Reasoning effort', DEFAULT_EFFORT)
  .option('--print', 'Print launch argv without running it')
  .action(async (opts) => {
    const state = await core(opts).status(opts.agent);
    if (opts.session && state.session?.id !== opts.session)
      throw new Error('Session changed before native launch.');
    const result = await launch(opts.repo, opts.agent, {
      ...opts,
      workspace: state.session?.workspace,
    });
    if (opts.print) output(result);
    else process.exitCode = result.exitCode;
  });

withRepo(
  program.command('control').description('Interactive user controls for a specific collaboration.'),
)
  .requiredOption('--session <id>')
  .action(async (opts) => {
    const { control } = await import('../src/control.js');
    await control(opts.repo, sessionIdSchema.parse(opts.session));
  });

withRepo(
  program
    .command('worker')
    .description(
      'Automatically run this peer when its next turn is ready; print the conversation in this pane.',
    ),
)
  .requiredOption('--agent <id>')
  .option('--model <model>')
  .option('--effort <level>', 'Reasoning effort', DEFAULT_EFFORT)
  .option('--timeout <ms>', 'Per-turn timeout', Number, DEFAULT_TURN_TIMEOUT_MS)
  .action(async (opts) => {
    const { runWorker } = await import('../src/worker.js');
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    try {
      const result = await runWorker({
        root: opts.repo,
        agent: opts.agent,
        model: opts.model,
        effort: opts.effort,
        timeoutMs: opts.timeout,
        signal: controller.signal,
        onEvent: (event) => output(event),
      });
      output(result);
      if (result.status === 'interrupted') process.exitCode = 130;
    } finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
    }
  });

try {
  await program.parseAsync();
} catch (error) {
  console.error(`model-collab: ${error.message}`);
  process.exitCode = 1;
}
