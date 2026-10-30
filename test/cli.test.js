import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../src/process.js';
import { gitProject } from './helpers.js';

const cli = fileURLToPath(new URL('../bin/model-collab.js', import.meta.url));
const skip =
  spawnSync('swarmchat', ['--version']).status === 0 ? false : 'swarmchat is not installed';

// Stand-ins for the agent CLIs: each session commits a file named after the
// agent, pushes it to main, and asks to wait.
const FAKE_AGENT = `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const backend = require('node:path').basename(process.argv[1]);
let prompt = '';
process.stdin.on('data', (chunk) => (prompt += chunk));
process.stdin.on('end', () => {
  const id = prompt.match(/You are ([a-z0-9-]+),/)[1];
  if (process.env.OPENAI_API_KEY || process.env.GITHUB_TOKEN) throw new Error('secret leaked');
  const git = (...args) => execFileSync('git', args, { stdio: 'pipe' });
  fs.writeFileSync(id + '.txt', id + '\\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Add ' + id);
  for (let i = 0; ; i++) {
    try {
      git('pull', '-q');
      git('push', '-q', 'origin', 'HEAD:main');
      break;
    } catch (error) {
      if (i > 10) throw error;
    }
  }
  const answer = { next: 'wait', summary: id + ' pushed ' + id + '.txt' };
  if (backend === 'codex') {
    const file = process.argv[process.argv.indexOf('--output-last-message') + 1];
    fs.writeFileSync(file, JSON.stringify(answer));
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 40, cached_input_tokens: 0, output_tokens: 4 } }));
  } else {
    console.log(JSON.stringify({ is_error: false, structured_output: answer, usage: { input_tokens: 30, output_tokens: 3 }, total_cost_usd: 0.001 }));
  }
});
`;

async function fakeAgents(t) {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'model-collab-fake-cli-'));
  t.after(() => fs.rm(bin, { recursive: true, force: true }));
  for (const name of ['claude', 'codex']) {
    await fs.writeFile(path.join(bin, name), FAKE_AGENT, { mode: 0o755 });
  }
  return bin;
}

function cliRunner(root, env = process.env) {
  return async (...args) => {
    const result = await runCommand([process.execPath, cli, ...args, '--repo', root], {
      cwd: root,
      env,
      timeoutMs: 120000,
      maxBytes: 1_000_000,
    });
    return { ...result, ok: result.code === 0 };
  };
}

test('settings are created, changed, and shown without starting agents', async (t) => {
  const root = await gitProject(t, 'model-collab-cli-');
  const run = cliRunner(root);
  const init = await run('init', '--agents', '5', '--minutes', '45');
  assert.ok(init.ok, init.stderr);
  assert.match(init.stdout, /Swarm: 3 Claude Code \(claude-opus-5-5\) \+ 2 Codex \(gpt-6-astra\)/);
  assert.match(init.stdout, /45 minutes per run/);
  assert.match(await fs.readFile(path.join(root, '.gitignore'), 'utf8'), /^\.collab\/$/m);
  await fs.access(path.join(root, '.collab', 'CONTEXT.md'));
  assert.match((await run('init')).stderr, /Already initialized/);

  const changed = JSON.parse(
    (
      await run(
        'configure',
        '--codex',
        '0',
        '--claude-model',
        'claude-test',
        '--checks',
        '{"test":["npm","test"]}',
        '--pass-env',
        'CARGO_NET_OFFLINE',
        '--json',
      )
    ).stdout,
  );
  assert.equal(changed.claude, 3);
  assert.equal(changed.codex, 0);
  assert.deepEqual(changed.models, { claude: 'claude-test' });
  assert.deepEqual(changed.checks, { test: ['npm', 'test'] });
  assert.deepEqual(changed.passEnv, ['CARGO_NET_OFFLINE']);
  const invalid = await run('configure', '--claude', '0');
  assert.equal(invalid.ok, false);
  assert.match(invalid.stderr, /at least one agent/);
  assert.match((await run('status')).stdout, /No run yet/);
  assert.match((await run('note', 'hello')).stderr, /No run is in progress/);
  assert.match((await run('stop')).stderr, /No run is in progress/);
});

test('up runs a swarm of real processes to a finished, applied result', { skip }, async (t) => {
  const root = await gitProject(t, 'model-collab-cli-up-');
  const bin = await fakeAgents(t);
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    OPENAI_API_KEY: 'sk-must-not-reach-agents',
    GITHUB_TOKEN: 'ghp_must_not_reach_agents',
  };
  const run = cliRunner(root, env);
  const up = await run(
    'up',
    'Each agent adds a file named after itself',
    '--claude',
    '2',
    '--codex',
    '1',
    '--quiet-seconds',
    '1',
    '--stagger-seconds',
    '0',
    '--checks',
    '{"three":["sh","-c","test -f claude-1.txt && test -f claude-2.txt && test -f codex-1.txt"]}',
    '--no-memory',
    '--json',
  );
  assert.ok(up.ok, `${up.stderr}\n${up.stdout.slice(-2000)}`);
  const events = up.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(events[0].event, 'started');
  assert.deepEqual(
    events[0].agents.map((a) => a.id),
    ['claude-1', 'codex-1', 'claude-2'],
  );
  const result = events.find((e) => e.event === 'result').run;
  assert.equal(result.status, 'finished', result.stopReason);
  assert.deepEqual(result.result.applied, ['claude-1.txt', 'claude-2.txt', 'codex-1.txt']);
  assert.equal(await fs.readFile(path.join(root, 'codex-1.txt'), 'utf8'), 'codex-1\n');
  const codex = result.agents.find((a) => a.id === 'codex-1');
  assert.deepEqual(
    [codex.usage.inputTokens, codex.usage.outputTokens, codex.lastSummary],
    [40, 4, 'codex-1 pushed codex-1.txt'],
  );
  assert.equal(result.agents.find((a) => a.id === 'claude-1').usage.costUsd, 0.001);

  const status = await run('status');
  assert.match(status.stdout, /finished/);
  assert.match(
    status.stdout,
    /Applied to your working tree: claude-1.txt, claude-2.txt, codex-1.txt/,
  );
  const transcript = await run('transcript');
  assert.match(transcript.stdout, /#general user: Goal \(run /);
  assert.match(transcript.stdout, /#general model-collab: Run finished/);
  assert.match((await run('apply')).stdout, /no file changes/);
});
