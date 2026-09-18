#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Collaboration } from '../src/core.js';
import { sessionIdSchema } from '../src/schema.js';
import { launch, serverConfig, writeInstructions } from '../src/setup.js';

const program = new Command().name('model-collab').description('Equal peers. Structured evidence. Bounded discussion.').version('0.1.0');
const output = value => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const withRepo = command => command.option('--repo <path>', 'Repository directory', process.cwd());
const core = options => new Collaboration(options.repo);
const list = value => value.split(',').map(s => s.trim()).filter(Boolean);
async function jsonInput(value) {
  if (value === '-') { let text = ''; for await (const chunk of process.stdin) text += chunk; return JSON.parse(text); }
  return JSON.parse(value.startsWith('@') ? await fs.readFile(value.slice(1), 'utf8') : value);
}

withRepo(program.command('init').description('Initialize repository-local state and peer prompts; preserve existing instructions.'))
  .option('--preset <name>', 'coding or research', 'coding')
  .option('--participants <ids>', 'Comma-separated peer IDs', 'codex,claude')
  .option('--max-rounds <n>', 'Discussion rounds after independent proposals', Number, 4)
  .option('--max-messages <n>', 'Hard cap on contributions', Number, 24)
  .option('--minutes <n>', 'Wall-clock session limit', Number, 20)
  .option('--checks <json>', 'JSON object of check names to argv arrays, or @file', '{}')
  .action(async opts => {
    const state = await core(opts).init({ preset: opts.preset, participants: list(opts.participants), maxRounds: opts.maxRounds, maxMessages: opts.maxMessages, deadlineMinutes: opts.minutes, checks: await jsonInput(opts.checks) });
    await writeInstructions(path.resolve(opts.repo), state.config.participants, { preset: state.config.preset });
    output({ initialized: path.resolve(opts.repo), config: state.config, next: 'model-collab start "Your goal"; then model-collab worker --agent claude and --agent codex in separate panes.' });
  });

withRepo(program.command('start').argument('<goal>')).option('--criteria <text...>', 'Success criteria').action(async (goal, opts) => output(await core(opts).start({ topic: goal, successCriteria: opts.criteria ?? [] })));
withRepo(program.command('status')).option('--agent <id>', 'Peer-filtered view').action(async opts => output(await core(opts).status(opts.agent)));
withRepo(program.command('post'))
  .requiredOption('--agent <id>')
  .requiredOption('--session <id>', 'Session UUID from the status used to prepare this contribution')
  .requiredOption('--json <value>', 'JSON message, @file, or - for stdin')
  .action(async opts => {
    const sessionId = sessionIdSchema.parse(opts.session);
    output(await core(opts).post(opts.agent, await jsonInput(opts.json), { sessionId }));
  });
withRepo(program.command('wait')).requiredOption('--agent <id>').requiredOption('--after <revision>', 'Last observed revision', Number).option('--timeout <ms>', 'Maximum 25000 ms', Number, 25000).action(async opts => output(await core(opts).wait(opts.agent, opts.after, opts.timeout)));
withRepo(program.command('claim')).requiredOption('--agent <id>').requiredOption('--files <paths...>').option('--seconds <n>', 'Lease length', Number, 300).action(async opts => output(await core(opts).claim(opts.agent, opts.files, opts.seconds)));
withRepo(program.command('release')).requiredOption('--agent <id>').option('--files <paths...>', 'Omit to release all').action(async opts => output(await core(opts).release(opts.agent, opts.files)));
withRepo(program.command('verify')).requiredOption('--agent <id>').requiredOption('--candidate <id>').requiredOption('--check <name>').action(async opts => output(await core(opts).verify(opts.agent, opts.candidate, opts.check)));
withRepo(program.command('stop')).option('--reason <text>', 'Stop reason', 'Stopped by user').action(async opts => output(await core(opts).stop(opts.reason)));
withRepo(program.command('pause').description('Pause protocol actions so the user can intervene.')).action(async opts => output(await core(opts).pause()));
withRepo(program.command('resume').description('Resume a paused session and extend its deadline by the paused duration.')).action(async opts => output(await core(opts).resume()));
withRepo(program.command('note').description('Share a user correction with both peers and invalidate prior votes/checks.').argument('<text>')).action(async (text, opts) => output(await core(opts).note(text)));
withRepo(program.command('await-turn').description('Wait locally until this peer can contribute; suitable for interactive agent shell tools.')).requiredOption('--agent <id>').option('--timeout <ms>', 'Maximum 300000 ms', Number, 300000).action(async opts => output(await core(opts).awaitTurn(opts.agent, opts.timeout)));
withRepo(program.command('export')).option('--format <type>', 'jsonl or markdown', 'jsonl').action(async opts => { if (!['jsonl', 'markdown'].includes(opts.format)) throw new Error('Format must be jsonl or markdown.'); process.stdout.write(await core(opts).transcript(opts.format)); });
withRepo(program.command('serve').description('Run stdio MCP server with a fixed participant identity.')).requiredOption('--agent <id>').option('--worker-tools', 'Expose only read, claim, release, and verification tools').action(async opts => { const { serve } = await import('../src/server.js'); await serve(opts.repo, opts.agent, opts); });
withRepo(program.command('refresh').description('Regenerate README and JSONL views from canonical state.')).action(async opts => output(await core(opts).refreshViews()));
withRepo(program.command('config').description('Print per-client MCP config without changing global settings.')).requiredOption('--agent <id>').action(async opts => output({ mcpServers: { model_collab: serverConfig(opts.repo, opts.agent) } }));
withRepo(program.command('launch').description('Launch interactive Codex or Claude in this terminal, with collaboration tools.'))
  .requiredOption('--agent <id>').option('--session <id>', 'Expected collaboration session').option('--model <model>', 'Model override').option('--effort <level>', 'Reasoning effort', 'xhigh').option('--print', 'Print launch argv without running it')
  .action(async opts => { const state = await core(opts).status(opts.agent); if (opts.session && state.session?.id !== opts.session) throw new Error('Session changed before native launch.'); const result = await launch(opts.repo, opts.agent, opts); if (opts.print) output(result); else process.exitCode = result.exitCode; });

withRepo(program.command('up').description('Initialize any project and automatically start both native agents in tmux panes.').argument('<goal>'))
  .option('--preset <name>', 'research (new projects) or coding')
  .option('--ui <mode>', 'tmux or workers', 'tmux')
  .option('--detach', 'Start native panes without attaching this terminal')
  .option('--print', 'Show a plan without modifying files or starting processes')
  .option('--resume', 'Explicitly resume the same paused goal')
  .option('--minutes <n>', 'New-project session deadline', Number, 30)
  .option('--max-rounds <n>', 'New-project discussion round cap', Number, 4)
  .option('--max-messages <n>', 'New-project message cap', Number, 24)
  .option('--checks <json>', 'New-project named checks as argv arrays, or @file')
  .option('--criteria <text...>', 'Success criteria')
  .option('--effort <level>', 'Reasoning effort', 'xhigh')
  .option('--codex-model <model>', 'Codex model', 'gpt-6-astra')
  .option('--claude-model <model>', 'Claude model', 'claude-fable-5-1[1m]')
  .action(async (goal, opts) => {
    const { up, attachTerminal } = await import('../src/up.js');
    const controller = new AbortController(), interrupt = () => controller.abort();
    process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
    try {
      const result = await up({ root: opts.repo, goal, preset: opts.preset, ui: opts.ui, print: opts.print, resume: opts.resume, minutes: opts.minutes, maxRounds: opts.maxRounds, maxMessages: opts.maxMessages, checks: opts.checks ? await jsonInput(opts.checks) : undefined, criteria: opts.criteria, effort: opts.effort, models: { codex: opts.codexModel, claude: opts.claudeModel }, signal: controller.signal, onEvent: event => output(event) });
      output(result);
      if (result.attach && !opts.detach && process.stdin.isTTY && process.stdout.isTTY && !process.env.TMUX) process.exitCode = await attachTerminal(result);
    } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
  });

withRepo(program.command('control').description('Interactive user controls for a specific collaboration.')).requiredOption('--session <id>').action(async opts => { const { control } = await import('../src/control.js'); await control(opts.repo, sessionIdSchema.parse(opts.session)); });

withRepo(program.command('worker').description('Automatically run this peer when its next turn is ready; print the conversation in this pane.'))
  .requiredOption('--agent <id>').option('--model <model>').option('--effort <level>', 'Reasoning effort', 'xhigh').option('--timeout <ms>', 'Per-turn timeout', Number, 120000)
  .action(async opts => {
    const { runWorker } = await import('../src/worker.js');
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
    try {
      const result = await runWorker({ root: opts.repo, agent: opts.agent, model: opts.model, effort: opts.effort, timeoutMs: opts.timeout, signal: controller.signal, onEvent: event => output(event) });
      output(result); if (result.status === 'interrupted') process.exitCode = 130;
    } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
  });

program.command('eval').description('Compare solo and collaborating agents with an equal aggregate call budget.')
  .option('--suite <name>', 'coding or rl', 'coding')
  .option('--tasks <ids>', 'Comma-separated task IDs (omit for all)')
  .option('--modes <ids>', 'Comma-separated conditions', 'solo-codex,solo-claude,independent-pair,collaboration')
  .option('--calls <n>', 'Equal total model calls per condition', Number, 4)
  .option('--trials <n>', 'Repeated trials, rotating mode order and final submitter', Number, 1)
  .option('--max-calls <n>', 'Hard aggregate invocation ceiling; must cover the balanced plan', Number, 24)
  .option('--minutes <n>', 'Global evaluation time limit', Number, 30)
  .option('--plan', 'Print the frozen evaluation plan without starting models')
  .option('--effort <level>', 'Reasoning effort', 'xhigh')
  .option('--timeout <ms>', 'Per-call timeout', Number, 60000)
  .option('--output <dir>', 'Result directory', 'eval-results')
  .option('--codex-model <model>', 'Codex model', 'gpt-6-astra')
  .option('--claude-model <model>', 'Claude model', 'claude-fable-5-1[1m]')
  .action(async opts => {
    const { runEvaluation, createEvaluationManifest, renderEvaluationMarkdown, renderTwitterDraft } = await import('../src/eval.js');
    const options = { suite: opts.suite, tasks: opts.tasks ? list(opts.tasks) : undefined, modes: list(opts.modes), callBudget: opts.calls, trials: opts.trials, effort: opts.effort, timeoutMs: opts.timeout, maxTotalCalls: opts.maxCalls, globalTimeoutMs: opts.minutes * 60000, outputDir: opts.output, models: { codex: opts.codexModel, claude: opts.claudeModel }, onProgress: event => console.error(JSON.stringify(event)) };
    if (opts.plan) { output(await createEvaluationManifest(options)); return; }
    const controller = new AbortController(), interrupt = () => controller.abort();
    process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
    try {
      const report = await runEvaluation({ ...options, signal: controller.signal });
      const reportPath = report.artifactPath.replace(/\.json$/, '.md');
      const draftPath = report.artifactPath.replace(/\.json$/, '.post-draft.txt');
      await fs.writeFile(reportPath, renderEvaluationMarkdown(report), { flag: 'wx' });
      await fs.writeFile(draftPath, renderTwitterDraft(report), { flag: 'wx' });
      output({ artifactPath: report.artifactPath, reportPath, draftPath, summary: report.summary, wallMs: report.wallMs, limitations: report.limitations });
      if (controller.signal.aborted) process.exitCode = 130;
    } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
  });

try { await program.parseAsync(); }
catch (error) { console.error(`model-collab: ${error.message}`); process.exitCode = 1; }
