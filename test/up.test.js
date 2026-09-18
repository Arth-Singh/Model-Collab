import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Collaboration } from '../src/core.js';
import { planUp, startTmux, up } from '../src/up.js';
import { runCommand } from '../src/process.js';

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/model-collab.js', import.meta.url));
const models = { codex: 'fixture-codex', claude: 'fixture-claude' };
const dangerous = `Investigate $(touch GOAL_INJECTION); 'double " quote' \`touch BACKTICK_INJECTION\`\nKeep this exact goal.`;

async function fixture(t, unusual = false) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'model-collab-up-'));
  const root = unusual ? path.join(base, `RL 'single' "double" $(touch PATH_INJECTION) \`touch PATH_TICK\``) : path.join(base, 'project');
  await fs.mkdir(root);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { root, base };
}

function fakeTmux() {
  const calls = [], sessions = new Map();
  const fake = { calls, sessions, fail: null };
  fake.run = async argv => {
    calls.push([...argv]);
    assert.deepEqual(argv.slice(0, 2), ['-L', 'model-collab']);
    const args = argv.slice(2), command = args[0];
    const option = name => args[args.indexOf(name) + 1];
    if (fake.fail === command) return { code: 1, stdout: '', stderr: `Injected ${command} failure` };
    if (command === 'has-session') return { code: sessions.has(option('-t')) ? 0 : 1, stdout: '', stderr: '' };
    if (command === 'new-session') {
      if (sessions.has(option('-s'))) return { code: 1, stdout: '', stderr: 'duplicate session' };
      sessions.set(option('-s'), { owner: '' });
    }
    if (command === 'set-option') sessions.get(option('-t')).owner = args.at(-1);
    if (command === 'show-options') return { code: 0, stdout: sessions.get(option('-t')).owner + '\n', stderr: '' };
    if (command === 'new-window') return { code: 0, stdout: '%100\n', stderr: '' };
    if (command === 'kill-session') sessions.delete(option('-t'));
    return { code: 0, stdout: '', stderr: '' };
  };
  return fake;
}

async function treeContents(root) {
  const files = {};
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files[path.relative(root, absolute)] = await fs.readFile(absolute, 'utf8');
    }
  }
  await visit(root);
  return files;
}

test('print plans arbitrary goals without filesystem or subprocess side effects, including expired sessions', async t => {
  const { root } = await fixture(t, true);
  const fake = fakeTmux();
  const before = await treeContents(root);
  const plan = await up({ root, goal: dangerous, print: true, runTmux: fake.run });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.task.topic, dangerous);
  assert.equal(plan.config.preset, 'research');
  assert.equal(plan.action, 'start');
  assert.deepEqual(await treeContents(root), before);
  assert.equal(fake.calls.length, 0);
  const printed = await execFileAsync(process.execPath, [cli, 'up', dangerous, '--repo', root, '--print']);
  assert.equal(JSON.parse(printed.stdout).task.topic, dangerous);
  assert.deepEqual(await treeContents(root), before);
  const collab = new Collaboration(root);
  await collab.init();
  await collab.start({ topic: 'Expired old goal' });
  const state = JSON.parse(await fs.readFile(collab.file, 'utf8'));
  state.session.deadlineAt = new Date(Date.now() - 1000).toISOString();
  await fs.writeFile(collab.file, JSON.stringify(state));
  const expiredFiles = await treeContents(root);
  assert.equal((await planUp({ root, goal: dangerous })).action, 'start');
  assert.deepEqual(await treeContents(root), expiredFiles);
});

test('startup preserves project instructions and context and passes unusual paths as literal argv', async t => {
  const { root } = await fixture(t, true);
  await fs.mkdir(path.join(root, '.collab'));
  const preserved = { 'AGENTS.md': 'Existing repository agent contract\n', 'CLAUDE.md': 'Existing Claude instructions\n', '.collab/CONTEXT.md': 'User experiment settings: seed=42\n' };
  for (const [name, content] of Object.entries(preserved)) await fs.writeFile(path.join(root, name), content);
  await fs.writeFile(path.join(root, '.gitignore'), 'checkpoints/\n');
  const fake = fakeTmux();
  const result = await up({ root, goal: dangerous, runTmux: fake.run, models });
  assert.equal(result.reused, false);
  const state = await new Collaboration(root).status();
  assert.equal(state.session.topic, dangerous);
  assert.equal(state.config.preset, 'research');
  for (const [name, content] of Object.entries(preserved)) assert.equal(await fs.readFile(path.join(root, name), 'utf8'), content);
  assert.equal(await fs.readFile(path.join(root, '.gitignore'), 'utf8'), 'checkpoints/\n.collab/\n');
  for (const name of ['START-CODEX.md', 'START-CLAUDE.md']) assert.ok((await fs.readFile(path.join(root, '.collab', name), 'utf8')).length > 100);
  const nativeCalls = fake.calls.filter(argv => ['new-window', 'split-window'].includes(argv[2]));
  assert.equal(nativeCalls.length, 2);
  for (const argv of nativeCalls) {
    assert.equal(argv[argv.indexOf('-c') + 1], await fs.realpath(root));
    assert.equal(argv[argv.indexOf('--repo') + 1], await fs.realpath(root));
    assert.equal(argv[argv.indexOf('--session') + 1], state.session.id);
    assert.ok(!argv.includes(dangerous), 'Goal belongs in state, never interpolated into a shell command');
  }
});

test('concurrent startup and repeated same-goal calls reuse one native pair; different goals fail', async t => {
  const { root, base } = await fixture(t);
  const fake = fakeTmux();
  const options = { root, goal: 'Reproduce the PPO instability.', runTmux: fake.run };
  const [first, second] = await Promise.all([up(options), up(options)]);
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(first.sessionName, second.sessionName);
  assert.equal([first, second].filter(result => result.reused).length, 1);
  assert.equal(fake.calls.filter(argv => argv[2] === 'new-session').length, 1);
  assert.equal(fake.calls.filter(argv => argv[2] === 'new-window').length, 1);
  assert.equal(fake.calls.filter(argv => argv[2] === 'split-window').length, 1);
  const alias = path.join(base, 'project-alias');
  await fs.symlink(root, alias);
  assert.equal((await up({ ...options, root: alias })).reused, true);
  const before = await treeContents(root);
  const callsBefore = fake.calls.length;
  await assert.rejects(up({ ...options, goal: 'Unrelated new experiment' }), /different goal/);
  assert.equal(fake.calls.length, callsBefore);
  assert.deepEqual(await treeContents(root), before);
});

test('paused goals remain paused unless resume is explicit and resume does not duplicate peers', async t => {
  const { root } = await fixture(t);
  const fake = fakeTmux();
  const options = { root, goal: 'Check a learning-curve regression.', runTmux: fake.run };
  const original = await up(options);
  const collab = new Collaboration(root);
  await collab.pause();
  const callCount = fake.calls.length;
  const paused = await up(options);
  assert.equal(paused.status, 'paused');
  assert.equal(fake.calls.length, callCount);
  assert.equal((await collab.status()).session.status, 'paused');
  const resumed = await up({ ...options, resume: true });
  assert.equal(resumed.sessionId, original.sessionId);
  assert.equal(resumed.reused, true);
  assert.equal((await collab.status()).session.status, 'active');
  assert.equal(fake.calls.filter(argv => argv[2] === 'new-session').length, 1);
});

test('startup failure cleans only its own tmux session and preserves the reusable collaboration', async t => {
  const { root } = await fixture(t);
  const fake = fakeTmux();
  fake.sessions.set('unrelated-user-session', { owner: 'not ours' });
  fake.fail = 'split-window';
  const options = { root, goal: 'Investigate bounded rollout failures.', runTmux: fake.run };
  await assert.rejects(up(options), /Injected split-window failure/);
  assert.deepEqual([...fake.sessions.keys()], ['unrelated-user-session']);
  const kills = fake.calls.filter(argv => argv[2] === 'kill-session');
  assert.equal(kills.length, 1);
  assert.notEqual(kills[0].at(-1), 'unrelated-user-session');
  const sessionId = (await new Collaboration(root).status()).session.id;
  fake.fail = null;
  const retry = await up(options);
  assert.equal(retry.sessionId, sessionId);
  assert.equal(retry.reused, false);
  assert.ok(fake.sessions.has('unrelated-user-session'));
});

test('a tmux ownership mismatch is rejected without killing or changing existing resources', async t => {
  const { root } = await fixture(t);
  const fake = fakeTmux();
  const options = { root, goal: 'Check gradient clipping.', runTmux: fake.run };
  const first = await up(options);
  fake.sessions.get(first.sessionName).owner = 'Somebody else owns this tmux session';
  const beforeCalls = fake.calls.length;
  await assert.rejects(up(options), /not owned/);
  assert.ok(fake.sessions.has(first.sessionName));
  assert.deepEqual(fake.calls.slice(beforeCalls).map(argv => argv[2]), ['has-session', 'show-options']);
});

test('workers fallback starts both peers with injected turns and no paid provider calls', { timeout: 5000 }, async t => {
  const { root } = await fixture(t);
  const turns = [];
  const result = await up({ root, goal: 'Check the overlap predicate.', ui: 'workers', turn: async ({ agent, state }) => {
    turns.push(agent);
    if (state.session.phase === 'independent') return { kind: 'proposal', summary: 'Use strict inequality.', evidence: ['Touching endpoints do not overlap.'], solution: 'max(start) < min(end)' };
    return { kind: 'accept', candidate: 'm1', summary: 'Boundary example agrees.', evidence: ['[1,2) and [2,3) have empty intersection.'] };
  } });
  assert.equal(turns.length, 4);
  assert.deepEqual(result.peers.map(peer => peer.status), ['converged', 'converged']);
  assert.deepEqual(result.peers.map(peer => peer.calls), [2, 2]);
});

test('real tmux passes quotes, spaces and shell syntax literally to fixture panes', { timeout: 10000 }, async t => {
  const version = await runCommand(['tmux', '-V'], { timeoutMs: 1000 });
  if (version.code !== 0 || version.error) { t.skip('tmux not installed'); return; }
  const { root: originalRoot } = await fixture(t, true);
  const root = originalRoot + ';';
  await fs.rename(originalRoot, root);
  const collab = new Collaboration(root);
  await collab.init({ preset: 'research' });
  const state = await collab.start({ topic: dangerous });
  const payload = `literal ' single " double $(touch PANE_INJECTION) \`touch PANE_TICK\`\nsecond line`;
  const code = 'require("node:fs").writeFileSync(process.argv[1],JSON.stringify({payload:process.argv[2],cwd:process.cwd()}));setInterval(()=>{},1000);';
  let ownedName;
  const run = async argv => {
    const result = await runCommand(['tmux', ...argv], { cwd: root, timeoutMs: 3000 });
    if (argv[2] === 'new-session' && result.code === 0) ownedName = argv[argv.indexOf('-s') + 1];
    return result;
  };
  t.after(async () => { if (ownedName) await runCommand(['tmux', '-L', 'model-collab', 'kill-session', '-t', ownedName], { timeoutMs: 3000 }); });
  const paneCommands = Object.fromEntries(['codex', 'claude'].map(agent => [agent, [process.execPath, '-e', code, path.join(root, `${agent}.json`), payload]]));
  const result = await startTmux({ root, sessionId: state.session.id, models, effort: 'xhigh', run, paneCommands });
  assert.equal(result.reused, false);
  for (const agent of ['codex', 'claude']) {
    const target = path.join(root, `${agent}.json`);
    let observed;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { observed = JSON.parse(await fs.readFile(target, 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.deepEqual(observed, { payload, cwd: await fs.realpath(root) });
  }
  for (const marker of ['PANE_INJECTION', 'PANE_TICK', 'PATH_INJECTION', 'PATH_TICK', 'GOAL_INJECTION', 'BACKTICK_INJECTION']) {
    await assert.rejects(fs.access(path.join(root, marker)), { code: 'ENOENT' });
  }
});
