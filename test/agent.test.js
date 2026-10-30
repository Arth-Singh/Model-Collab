import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { agentEnv, codexBusy, readOutput, runSession, sessionArgs } from '../src/agent.js';

const agent = (backend, dir = '/w') => ({
  id: `${backend}-1`,
  backend,
  model: backend === 'claude' ? 'claude-test' : 'codex-test',
  effort: 'low',
  workspace: path.join(dir, 'work'),
  gitDir: path.join(dir, 'git'),
});
const mcp = { command: '/usr/bin/node', args: ['bin/model-collab.js', 'serve', '--agent', 'x'] };

async function scratch(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-collab-agent-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A fake process runner that answers like the backend would. */
function fakeRun(answers) {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (answer.final) {
      const file = args[args.indexOf('--output-last-message') + 1];
      await fs.writeFile(file, JSON.stringify(answer.final));
    }
    return { code: 0, stdout: '', stderr: '', error: null, wallMs: 5, ...answer.result };
  };
  return { run, calls };
}

const claudeJson = (fields) =>
  JSON.stringify({
    is_error: false,
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 100,
      output_tokens: 7,
    },
    total_cost_usd: 0.02,
    ...fields,
  });

test('agents get a toolchain environment without secrets', () => {
  const env = agentEnv(
    {
      PATH: '/bin',
      HOME: '/home/u',
      LC_ALL: 'C',
      XDG_CONFIG_HOME: '/c',
      CARGO_HOME: '/cargo',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      OPENAI_API_KEY: 'sk-secret',
      GITHUB_TOKEN: 'ghp_secret',
      HF_TOKEN: 'hf_secret',
      AWS_SECRET_ACCESS_KEY: 'x',
      MY_TOOL_FLAG: '1',
    },
    ['MY_TOOL_FLAG'],
  );
  assert.deepEqual(Object.keys(env).sort(), [
    'CARGO_HOME',
    'HOME',
    'LC_ALL',
    'MY_TOOL_FLAG',
    'PATH',
    'XDG_CONFIG_HOME',
  ]);
});

test('Codex sessions are sandboxed, offline, and may write their Git directory and the origin', () => {
  const args = sessionArgs({
    agent: agent('codex'),
    origin: '/o.git',
    mcp,
    schemaFile: '/s.json',
    finalFile: '/f.json',
  });
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(args[0], 'exec');
  for (const flag of ['--ignore-user-config', '--ignore-rules', '--ephemeral', '--json'])
    assert.ok(args.includes(flag), flag);
  assert.equal(value('--sandbox'), 'workspace-write');
  assert.deepEqual(
    args.flatMap((a, i) => (a === '--add-dir' ? [args[i + 1]] : [])),
    ['/w/git', '/o.git'],
  );
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(args.includes(`mcp_servers.model_collab.args=${JSON.stringify(mcp.args)}`));
  assert.equal(value('--cd'), '/w/work');
  assert.equal(value('--model'), 'codex-test');
});

test('Claude sessions have no web tools and run every shell command in the sandbox', () => {
  const args = sessionArgs({ agent: agent('claude'), origin: '/o.git', mcp });
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(value('--tools'), 'Read,Glob,Grep,Edit,Write,Bash');
  assert.equal(value('--model'), 'claude-test');
  assert.deepEqual(JSON.parse(value('--mcp-config')), { mcpServers: { model_collab: mcp } });
  assert.deepEqual(JSON.parse(value('--settings')).sandbox, {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
  });
  assert.deepEqual(
    args.flatMap((a, i) => (a === '--add-dir' ? [args[i + 1]] : [])),
    ['/w/git', '/o.git'],
  );
});

test('a Claude session returns its decision and usage', async (t) => {
  const dir = await scratch(t);
  const { run, calls } = fakeRun([
    {
      result: {
        stdout: claudeJson({ structured_output: { next: 'wait', summary: ' Pushed the lexer. ' } }),
      },
    },
  ]);
  const result = await runSession({
    agent: agent('claude', dir),
    origin: '/o.git',
    mcp,
    prompt: 'Do the work',
    logDir: path.join(dir, 'logs'),
    timeoutMs: 1000,
    deadlineMs: Date.now() + 1000,
    env: { PATH: '/bin', OPENAI_API_KEY: 'sk-secret' },
    run,
  });
  assert.deepEqual(result, {
    next: 'wait',
    summary: 'Pushed the lexer.',
    wallMs: 5,
    usage: { inputTokens: 115, cachedInputTokens: 100, outputTokens: 7, costUsd: 0.02 },
  });
  assert.equal(calls[0].options.input, 'Do the work');
  assert.equal(calls[0].options.cwd, path.join(dir, 'work'));
  assert.deepEqual(calls[0].options.env, {
    PATH: '/bin',
    GOCACHE: path.join(dir, 'work', '.gocache'),
  });
  assert.equal(
    (await fs.readdir(path.join(dir, 'logs'))).filter((f) => f.endsWith('.log.json')).length,
    1,
  );
});

test('a Codex session reads its decision from the last-message file and sums usage', async (t) => {
  const dir = await scratch(t);
  const events = [
    {
      type: 'turn.completed',
      usage: { input_tokens: 50, cached_input_tokens: 40, output_tokens: 9 },
    },
    {
      type: 'turn.completed',
      usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 1 },
    },
  ];
  const { run } = fakeRun([
    {
      final: { next: 'continue', summary: 'Half done' },
      result: { stdout: events.map((e) => JSON.stringify(e)).join('\n') },
    },
  ]);
  const result = await runSession({
    agent: agent('codex', dir),
    origin: '/o.git',
    mcp,
    prompt: 'p',
    logDir: path.join(dir, 'logs'),
    timeoutMs: 1000,
    deadlineMs: Date.now() + 1000,
    run,
  });
  assert.equal(result.next, 'continue');
  assert.deepEqual(result.usage, {
    inputTokens: 55,
    cachedInputTokens: 40,
    outputTokens: 10,
    costUsd: null,
  });
});

test('usage limits are reported as rate limiting, other failures as errors', async (t) => {
  const dir = await scratch(t);
  const session = (answers, backend = 'claude') =>
    runSession({
      agent: agent(backend, dir),
      origin: '/o.git',
      mcp,
      prompt: 'p',
      logDir: path.join(dir, 'logs'),
      timeoutMs: 1000,
      deadlineMs: Date.now() + 1000,
      run: fakeRun(answers).run,
    });
  const limited = await session([
    {
      result: {
        code: 1,
        stdout: claudeJson({ is_error: true, result: 'Claude AI usage limit reached|1793370000' }),
      },
    },
  ]);
  assert.equal(limited.failure.kind, 'rate_limited');
  const codexLimited = await session(
    [
      {
        result: {
          code: 1,
          stdout: JSON.stringify({ type: 'error', message: "You've hit your usage limit." }),
        },
      },
    ],
    'codex',
  );
  assert.equal(codexLimited.failure.kind, 'rate_limited');
  const broken = await session([{ result: { code: 2, stderr: 'segfault' } }]);
  assert.deepEqual(broken.failure, { kind: 'error', message: 'segfault' });
  const silent = await session([{ result: { stdout: '' } }]);
  assert.deepEqual(silent.failure, { kind: 'error', message: 'Claude printed no result.' });
  const timedOut = await session([{ result: { code: null, error: 'timeout' } }]);
  assert.equal(timedOut.failure.kind, 'timeout');
  const malformed = await session([
    { result: { stdout: claudeJson({ structured_output: { next: 'later', summary: 'x' } }) } },
  ]);
  assert.match(malformed.failure.message, /next, summary/);
});

test('a stalled Codex session is retried once with a note, then reported', async (t) => {
  const dir = await scratch(t);
  const { run, calls } = fakeRun([{ result: { code: null, error: 'stalled' } }]);
  const result = await runSession({
    agent: agent('codex', dir),
    origin: '/o.git',
    mcp,
    prompt: 'p',
    logDir: path.join(dir, 'logs'),
    timeoutMs: 1000,
    deadlineMs: Date.now() + 1000,
    run,
  });
  assert.equal(calls.length, 2);
  assert.match(calls[1].options.input, /STOPPED RESPONDING/);
  assert.equal(result.failure.kind, 'stalled');
});

test('Codex is busy only while a started item has not completed', () => {
  const started = JSON.stringify({ type: 'item.started', item: { id: 'a' } });
  const done = JSON.stringify({ type: 'item.completed', item: { id: 'a' } });
  assert.equal(codexBusy(started), true);
  assert.equal(codexBusy(`${started}\n${done}`), false);
  assert.equal(readOutput('claude', 'not json').response, null);
});
