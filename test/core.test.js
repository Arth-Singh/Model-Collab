import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Collaboration } from '../src/core.js';
import { launch, writeInstructions } from '../src/setup.js';
import { gitProject } from './helpers.js';

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/model-collab.js', import.meta.url));
let serial = 0;
const message = (kind, extra = {}) => ({
  clientMessageId: `test-message-${++serial}`,
  kind,
  summary: `${kind} backed by a check`,
  evidence: ['Boundary example produces the expected result.'],
  ...(kind === 'proposal' ? { solution: `Answer ${serial}: max(start) < min(end).` } : {}),
  ...extra,
});

async function fixture(t, config = {}, files) {
  const root = await gitProject(t, 'model-collab-test-', files);
  const collab = new Collaboration(root);
  await collab.init(config);
  await collab.start({
    topic: 'Implement a correct interval intersection.',
    successCriteria: ['Adjacent intervals do not overlap.'],
  });
  return { root, collab };
}

const workspace = async (collab, agent) => (await collab.status(agent)).session.workspace;
async function edit(collab, agent, file, content) {
  const target = path.join(await workspace(collab, agent), file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

async function independent(collab, extra = {}) {
  const first = await collab.post('codex', message('proposal', extra));
  const second = await collab.post('claude', message('proposal'));
  return [first.message.id, second.message.id];
}

test('settings change only between goals and preserve prior conversation history', async (t) => {
  const { collab } = await fixture(t);
  await independent(collab);
  const current = await fs.readFile(collab.file, 'utf8');
  await assert.rejects(collab.configure({ maxRounds: 6 }), /Stop the current/);
  assert.equal(await fs.readFile(collab.file, 'utf8'), current);
  await collab.pause();
  await assert.rejects(collab.configure({ maxRounds: 6 }), /Stop the current/);
  await collab.stop('Change settings for the next task.');
  const previous = JSON.parse(await fs.readFile(collab.file, 'utf8'));
  const updated = await collab.configure({
    preset: 'research',
    maxRounds: 6,
    deadlineMinutes: 45,
    checks: { test: ['node', '--version'] },
  });
  assert.deepEqual(updated.session, previous.session);
  assert.equal(updated.config.maxRounds, 6);
  assert.equal(updated.config.preset, 'research');
  const beforeInvalid = await fs.readFile(collab.file, 'utf8');
  await assert.rejects(collab.configure({ maxRounds: 0 }));
  await assert.rejects(collab.configure({ participants: ['someone-else'] }), /Unsupported/);
  assert.equal(await fs.readFile(collab.file, 'utf8'), beforeInvalid);
  const next = await collab.start({ topic: 'Use the updated configuration.' });
  assert.equal(next.config.deadlineMinutes, 45);
  const history = JSON.parse(
    await fs.readFile(path.join(collab.dir, 'history', `${previous.session.id}.json`), 'utf8'),
  );
  assert.deepEqual(history.messages, previous.session.messages);
});

test('each peer gets a private Git worktree of the current project, including uncommitted work', async (t) => {
  const root = await gitProject(t, 'model-collab-test-', {
    'src/a.js': 'export const a = 1;\n',
    '.gitignore': 'node_modules/\n.collab/\n',
  });
  await fs.writeFile(path.join(root, 'src/a.js'), 'export const a = 2; // uncommitted\n');
  await fs.writeFile(path.join(root, 'notes.txt'), 'untracked\n');
  await fs.mkdir(path.join(root, 'node_modules/dep'), { recursive: true });
  await fs.writeFile(path.join(root, 'node_modules/dep/index.js'), 'module.exports = 1;\n');
  const collab = new Collaboration(root);
  await collab.init();
  await collab.start({ topic: 'Change a.' });
  const codex = await workspace(collab, 'codex');
  const claude = await workspace(collab, 'claude');
  assert.notEqual(codex, claude);
  assert.ok(codex.startsWith(path.join(root, '.collab', 'work')));
  assert.equal(
    await fs.readFile(path.join(codex, 'src/a.js'), 'utf8'),
    'export const a = 2; // uncommitted\n',
  );
  assert.equal(await fs.readFile(path.join(codex, 'notes.txt'), 'utf8'), 'untracked\n');
  assert.equal(
    await fs.readFile(path.join(codex, 'node_modules/dep/index.js'), 'utf8'),
    'module.exports = 1;\n',
  );
  const view = (await collab.status('codex')).session;
  assert.equal(view.workspaces, undefined);
  assert.equal(view.base, undefined);
  await fs.writeFile(path.join(codex, 'src/a.js'), 'export const a = 3;\n');
  assert.equal(
    await fs.readFile(path.join(claude, 'src/a.js'), 'utf8'),
    'export const a = 2; // uncommitted\n',
  );
  assert.equal(
    await fs.readFile(path.join(root, 'src/a.js'), 'utf8'),
    'export const a = 2; // uncommitted\n',
  );
});

test('proposals snapshot changed files; dependency links and .collab are never captured', async (t) => {
  const { root, collab } = await fixture(
    t,
    {},
    {
      'src/a.js': 'old\n',
      'remove-me.txt': 'x\n',
      '.gitignore': 'node_modules/\n.collab/\n',
    },
  );
  await assert.rejects(
    collab.post('codex', message('proposal', { solution: undefined })),
    /no changes/,
  );
  const ws = await workspace(collab, 'codex');
  await fs.writeFile(path.join(ws, 'src/a.js'), 'new\n');
  await fs.writeFile(path.join(ws, 'src/b.js'), 'added\n');
  await fs.rm(path.join(ws, 'remove-me.txt'));
  await fs.mkdir(path.join(ws, 'src/__pycache__'));
  await fs.writeFile(path.join(ws, 'src/__pycache__/b.cpython-313.pyc'), 'bytecode');
  await fs.writeFile(path.join(ws, '.DS_Store'), 'finder');
  const posted = await collab.post('codex', message('proposal', { solution: undefined }));
  const candidate = (await collab.status('codex')).session.candidates[0];
  assert.deepEqual(
    candidate.changes.map((c) => [c.path, c.status]),
    [
      ['remove-me.txt', 'deleted'],
      ['src/a.js', 'modified'],
      ['src/b.js', 'added'],
    ],
  );
  await fs.writeFile(path.join(ws, 'src/a.js'), 'edited after proposing\n');
  const checkout = await collab.checkout('codex', posted.message.id);
  assert.equal(await fs.readFile(path.join(checkout.path, 'src/a.js'), 'utf8'), 'new\n');
  await assert.rejects(fs.access(path.join(checkout.path, 'remove-me.txt')));
  const { diff } = await collab.diff('codex', posted.message.id);
  assert.match(diff, /-old\n\+new/);
  assert.match(diff, /\+added/);
  assert.equal(await fs.readFile(path.join(root, 'src/a.js'), 'utf8'), 'old\n');
});

test('the tie-break lets each peer accept the smaller ID, including its own', async (t) => {
  const { collab } = await fixture(t);
  const [first] = await independent(collab);
  const own = await collab.post('codex', message('accept', { candidate: first }));
  assert.equal(own.status, 'active');
  const agreed = await collab.post('claude', message('accept', { candidate: first }));
  assert.equal(agreed.status, 'converged');
  assert.equal(agreed.winner, first);
});

test('untracked caches in the user tree stay out of the base and every candidate', async (t) => {
  const root = await gitProject(t, 'model-collab-cache-', { 'src/m.py': 'x = 1\n' });
  await fs.mkdir(path.join(root, 'src/__pycache__'));
  await fs.writeFile(path.join(root, 'src/__pycache__/m.cpython-313.pyc'), 'stale');
  await fs.writeFile(path.join(root, 'top.pyc'), 'stale');
  const collab = new Collaboration(root);
  await collab.init();
  await collab.start({ topic: 'Change m.' });
  const ws = await workspace(collab, 'codex');
  await assert.rejects(fs.access(path.join(ws, 'src/__pycache__')));
  await fs.writeFile(path.join(ws, 'src/m.py'), 'x = 2\n');
  await fs.mkdir(path.join(ws, 'src/__pycache__'));
  await fs.writeFile(path.join(ws, 'src/__pycache__/m.cpython-313.pyc'), 'fresh');
  await fs.writeFile(path.join(ws, 'top.pyc'), 'fresh');
  await collab.post('codex', message('proposal'));
  assert.deepEqual(
    (await collab.status('codex')).session.candidates[0].changes.map((c) => [c.path, c.status]),
    [['src/m.py', 'modified']],
  );
});

test('independent proposals remain sealed until every peer submits; each peer gets one contribution per round', async (t) => {
  const { collab } = await fixture(t);
  await assert.rejects(collab.post('codex', message('evidence')), /independent proposal/);
  const own = await collab.post('codex', message('proposal'));
  const sealed = await collab.status('claude');
  assert.equal(sealed.session.phase, 'independent');
  assert.deepEqual(sealed.session.messages, []);
  assert.deepEqual(sealed.session.candidates, []);
  assert.deepEqual(sealed.session.independentPeersPending, ['claude']);
  await assert.rejects(collab.diff('claude', own.message.id), /Unknown candidate/);
  await assert.rejects(collab.checkout('claude', own.message.id), /Unknown candidate/);
  assert.equal((await collab.status('codex')).session.messages[0].id, own.message.id);
  await assert.rejects(collab.post('codex', message('proposal')), /already contributed/);
  await collab.post('claude', message('proposal'));
  const shared = await collab.status('claude');
  assert.equal(shared.session.phase, 'discussion');
  assert.equal(shared.session.round, 1);
  assert.equal(shared.session.messages.length, 2);
  await assert.doesNotReject(collab.diff('claude', own.message.id));
  await collab.post('claude', message('evidence'));
  await assert.rejects(collab.post('claude', message('evidence')), /already contributed/);
});

test('proposing endorses: one acceptance of the peer candidate converges and applies it', async (t) => {
  const { root, collab } = await fixture(t, {}, { 'answer.txt': 'unknown\n' });
  await edit(collab, 'codex', 'answer.txt', 'half-open\n');
  await edit(collab, 'claude', 'answer.txt', 'closed\n');
  const [codex] = await independent(collab);
  assert.deepEqual((await collab.status()).session.votes, { codex: 'm1', claude: 'm2' });
  const result = await collab.post('claude', message('accept', { candidate: codex }));
  assert.equal(result.status, 'converged');
  assert.equal(result.winner, codex);
  assert.deepEqual(result.applied.files, ['answer.txt']);
  assert.equal(await fs.readFile(path.join(root, 'answer.txt'), 'utf8'), 'half-open\n');
  await assert.rejects(collab.post('codex', message('evidence')), /converged/);
});

test('agreement requires every participant to back the same candidate', async (t) => {
  const { collab } = await fixture(t, { participants: ['codex', 'claude', 'reviewer'] });
  const first = await collab.post('codex', message('proposal'));
  await collab.post('claude', message('proposal'));
  await collab.post('reviewer', message('proposal'));
  const candidate = first.message.id;
  assert.equal((await collab.post('claude', message('accept', { candidate }))).status, 'active');
  const result = await collab.post('reviewer', message('accept', { candidate }));
  assert.equal(result.status, 'converged');
  assert.equal(result.winner, candidate);
});

test('split votes do not converge; a revision supersedes and drops votes for the old candidate', async (t) => {
  const { collab } = await fixture(t);
  const [a, b] = await independent(collab);
  await collab.post('codex', message('accept', { candidate: a }));
  await collab.post('claude', message('accept', { candidate: b }));
  assert.equal((await collab.status()).session.status, 'active');
  await collab.post('claude', message('accept', { candidate: a }));
  let s = (await collab.status()).session;
  assert.equal(s.status, 'converged');
  const again = await fixture(t);
  const [c] = await independent(again.collab);
  await again.collab.post('claude', message('challenge', { candidate: c }));
  const revision = await again.collab.post(
    'codex',
    message('proposal', { summary: 'Revised candidate handles the challenged case.' }),
  );
  s = (await again.collab.status()).session;
  assert.equal(s.candidates.find((x) => x.id === c).supersededBy, revision.message.id);
  assert.deepEqual(s.votes, { codex: revision.message.id, claude: 'm2' });
  await assert.rejects(
    again.collab.post('claude', message('accept', { candidate: c })),
    /superseded/,
  );
});

test('open challenges block agreement and only their author can close them', async (t) => {
  const { collab } = await fixture(t);
  const [candidate] = await independent(collab);
  const challenge = await collab.post('claude', message('challenge', { candidate }));
  await assert.rejects(collab.post('codex', message('accept', { candidate })), /open challenges/);
  await assert.rejects(
    collab.post('codex', message('evidence', { resolves: [challenge.message.id] })),
    /original challenger/,
  );
  await collab.post('codex', message('evidence', { repliesTo: challenge.message.id }));
  const final = await collab.post(
    'claude',
    message('accept', { candidate, resolves: [challenge.message.id] }),
  );
  assert.equal(final.status, 'converged');
  assert.ok((await collab.status()).session.challenges[0].resolvedBy);
});

test('required checks run in a clean checkout of the candidate and gate acceptance', async (t) => {
  const { root, collab } = await fixture(
    t,
    {
      checks: {
        unit: [
          process.execPath,
          '-e',
          'if(require("node:fs").readFileSync("answer.txt","utf8")!=="correct")process.exit(2)',
        ],
      },
    },
    { 'answer.txt': 'unknown' },
  );
  await edit(collab, 'codex', 'answer.txt', 'wrong');
  await edit(collab, 'claude', 'answer.txt', 'correct');
  const [wrong, right] = await independent(collab);
  await edit(collab, 'codex', 'answer.txt', 'correct');
  assert.equal((await collab.verify('claude', wrong, 'unit')).passed, false);
  await assert.rejects(
    collab.post('claude', message('accept', { candidate: wrong })),
    /Required checks/,
  );
  await assert.rejects(
    collab.post('codex', message('accept', { candidate: right })),
    /Required checks/,
  );
  assert.equal((await collab.verify('codex', right, 'unit')).passed, true);
  assert.equal(await fs.readFile(path.join(root, 'answer.txt'), 'utf8'), 'unknown');
  const result = await collab.post('codex', message('accept', { candidate: right }));
  assert.equal(result.status, 'converged');
  assert.equal(await fs.readFile(path.join(root, 'answer.txt'), 'utf8'), 'correct');
  assert.deepEqual(await fs.readdir(path.join(collab.dir, 'checkouts')), []);
});

test('a check that edits files cannot change the candidate it verifies', async (t) => {
  const { collab } = await fixture(
    t,
    {
      checks: {
        mutate: [
          process.execPath,
          '-e',
          'const fs=require("node:fs");if(fs.readFileSync("answer.txt","utf8")!=="original")process.exit(3);fs.writeFileSync("answer.txt","modified")',
        ],
      },
    },
    { 'answer.txt': 'original' },
  );
  await edit(collab, 'codex', 'extra.txt', 'x');
  const [candidate] = await independent(collab);
  assert.equal((await collab.verify('codex', candidate, 'mutate')).passed, true);
  assert.equal((await collab.verify('claude', candidate, 'mutate')).passed, true);
});

test('verbose passing checks pass with a truncated tail and slow checks honor the project timeout', async (t) => {
  const { collab } = await fixture(t, {
    checkTimeoutSeconds: 1,
    checks: {
      verbose: [
        process.execPath,
        '-e',
        'process.stdout.write("x".repeat(500000) + "\\nSUMMARY: all passed\\n")',
      ],
      slow: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'],
    },
  });
  const [candidate] = await independent(collab);
  const verbose = await collab.verify('codex', candidate, 'verbose');
  assert.equal(verbose.passed, true);
  assert.equal(verbose.outputTruncated, true);
  assert.ok(verbose.stdout.length <= 12000);
  assert.match(verbose.stdout, /SUMMARY: all passed\n$/);
  const slow = await collab.verify('codex', candidate, 'slow');
  assert.equal(slow.passed, false);
  assert.equal(slow.error, 'timeout');
  assert.ok(slow.durationMs < 4000);
  await assert.rejects(collab.verify('codex', candidate, 'constructor'), /Unknown check/);
});

test('the agreed candidate is not applied over user edits; apply works once they are resolved', async (t) => {
  const { root, collab } = await fixture(t, {}, { 'answer.txt': 'base\n' });
  await edit(collab, 'codex', 'answer.txt', 'agreed\n');
  const [candidate] = await independent(collab);
  await fs.writeFile(path.join(root, 'answer.txt'), 'user edit\n');
  const result = await collab.post('claude', message('accept', { candidate }));
  assert.equal(result.status, 'converged');
  assert.match(result.applied.error, /you changed answer.txt/);
  assert.equal(await fs.readFile(path.join(root, 'answer.txt'), 'utf8'), 'user edit\n');
  await assert.rejects(collab.apply(), /you changed answer.txt/);
  await fs.writeFile(path.join(root, 'answer.txt'), 'base\n');
  assert.deepEqual((await collab.apply()).files, ['answer.txt']);
  assert.equal(await fs.readFile(path.join(root, 'answer.txt'), 'utf8'), 'agreed\n');
  await assert.rejects(collab.apply('m99'), /Unknown candidate/);
});

test('identical retries are idempotent, conflicting retries fail, and invalid input leaves state unchanged', async (t) => {
  const { collab } = await fixture(t);
  const body = message('proposal');
  const original = await collab.post('codex', body);
  const before = await collab.status();
  const retry = await collab.post('codex', body);
  assert.equal(retry.duplicate, true);
  assert.deepEqual(retry.message, original.message);
  await assert.rejects(
    collab.post('codex', { ...body, summary: 'Different answer' }),
    /different content/,
  );
  await assert.rejects(
    collab.post('claude', message('proposal', { evidence: [] })),
    /Provide evidence/,
  );
  await assert.rejects(collab.post('unknown', message('proposal')), /Unknown participant/);
  await assert.rejects(collab.post('claude', { ...message('proposal'), unsupported: true }));
  await assert.rejects(collab.post('claude', { ...message('proposal'), files: ['a.js'] }));
  assert.deepEqual(await collab.status(), before);
});

test('process locking preserves simultaneous proposals and rejects racing duplicate turns', async (t) => {
  const { root, collab } = await fixture(t);
  const sessionId = (await collab.status('codex')).session.id;
  const post = (agent, body) =>
    execFileAsync(process.execPath, [
      cli,
      'post',
      '--repo',
      root,
      '--agent',
      agent,
      '--session',
      sessionId,
      '--json',
      JSON.stringify(body),
    ]);
  await Promise.all([post('codex', message('proposal')), post('claude', message('proposal'))]);
  const first = await collab.status();
  assert.equal(first.session.messages.length, 2);
  assert.equal(first.session.round, 1);
  const racing = await Promise.allSettled([
    post('codex', message('evidence')),
    post('codex', message('evidence')),
  ]);
  assert.equal(racing.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(racing.filter((r) => r.status === 'rejected').length, 1);
  assert.equal((await collab.status()).session.messages.length, 3);
  await assert.doesNotReject(
    fs.readFile(path.join(root, '.collab', 'state.json'), 'utf8').then(JSON.parse),
  );
});

test('message and discussion-round limits stop debate without inventing a winner', async (t) => {
  for (const [config, reason] of [
    [{ maxMessages: 4 }, 'message_limit'],
    [{ maxRounds: 1 }, 'round_limit'],
  ]) {
    const { collab } = await fixture(t, config);
    await independent(collab);
    await collab.post('codex', message('evidence'));
    const result = await collab.post('claude', message('evidence'));
    assert.equal(result.status, 'exhausted');
    const state = await collab.status();
    assert.equal(state.session.stopReason, reason);
    assert.equal(state.session.winner, null);
    assert.equal(state.session.applied, null);
    await assert.rejects(collab.post('codex', message('proposal')), /exhausted/);
  }
});

test('deadline expiry persists even when the triggering write is rejected', async (t) => {
  const { root, collab } = await fixture(t);
  const file = path.join(root, '.collab', 'state.json');
  const state = JSON.parse(await fs.readFile(file, 'utf8'));
  state.session.deadlineAt = new Date(Date.now() - 1000).toISOString();
  await fs.writeFile(file, JSON.stringify(state));
  await assert.rejects(collab.post('codex', message('proposal')), /exhausted/);
  const persisted = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(persisted.session.status, 'exhausted');
  assert.equal(persisted.session.stopReason, 'deadline');
  assert.equal(persisted.revision, state.revision + 1);
});

test('semantic duplicates cannot prolong a discussion', async (t) => {
  const { collab } = await fixture(t);
  await independent(collab);
  const evidence = message('evidence', { summary: 'Exhaustively checked endpoints from 0 to 5.' });
  await collab.post('claude', evidence);
  await collab.post('codex', message('evidence', { summary: 'Different finding.' }));
  await assert.rejects(
    collab.post('claude', { ...evidence, clientMessageId: 'another-message-id' }),
    /Repeated contribution/,
  );
  assert.equal((await collab.status()).session.messages.length, 4);
});

test('start, stop and restart archive prior sessions, replace worktrees, and preserve user context', async (t) => {
  const { root, collab } = await fixture(t);
  const original = await collab.status();
  const oldWorkspace = await workspace(collab, 'codex');
  await assert.rejects(collab.init(), /Already initialized/);
  await assert.rejects(collab.start({ topic: 'Overlapping session' }), /already active/);
  await writeInstructions(root, ['codex', 'claude']);
  await fs.writeFile(path.join(root, '.collab', 'CONTEXT.md'), 'User-owned context');
  await writeInstructions(root, ['codex', 'claude']);
  assert.equal(
    await fs.readFile(path.join(root, '.collab', 'CONTEXT.md'), 'utf8'),
    'User-owned context',
  );
  await fs.writeFile(path.join(oldWorkspace, 'scratch.txt'), 'old session work');
  await collab.stop('User paused this experiment');
  const next = await collab.start({ topic: 'A new user-requested goal' });
  assert.notEqual(next.session.id, original.session.id);
  await assert.rejects(fs.access(path.join(await workspace(collab, 'codex'), 'scratch.txt')));
  const { stdout } = await execFileAsync('git', ['worktree', 'list'], { cwd: root });
  assert.equal(stdout.trim().split('\n').length, 3);
  const archived = JSON.parse(
    await fs.readFile(path.join(root, '.collab', 'history', `${original.session.id}.json`), 'utf8'),
  );
  assert.equal(archived.status, 'stopped');
  assert.equal(archived.stopReason, 'User paused this experiment');
  const codexWorkspace = await workspace(collab, 'codex');
  const codex = await launch(root, 'codex', { print: true, workspace: codexWorkspace });
  const claude = await launch(root, 'claude', {
    print: true,
    workspace: await workspace(collab, 'claude'),
  });
  assert.equal(codex.cwd, codexWorkspace);
  assert.deepEqual(codex.args.slice(0, 6), [
    '-C',
    codexWorkspace,
    '--sandbox',
    'workspace-write',
    '--add-dir',
    path.join(root, '.collab'),
  ]);
  assert.ok(codex.args.some((arg) => arg.includes('mcp_servers.model_collab')));
  assert.ok(claude.args.includes('--mcp-config'));
  await assert.rejects(launch(root, 'codex', { print: true }), /No workspace/);
});

test('a project without Git is rejected with an actionable message', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-collab-nogit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const collab = new Collaboration(root);
  await collab.init();
  await assert.rejects(collab.start({ topic: 'Anything' }), /needs a Git repository.*git init/);
  assert.equal((await collab.status()).session, null);
});

test('open sessions from the shared-tree protocol are stopped on upgrade', async (t) => {
  const root = await gitProject(t, 'model-collab-upgrade-');
  await fs.mkdir(path.join(root, '.collab'));
  await fs.writeFile(
    path.join(root, '.collab', 'state.json'),
    JSON.stringify({
      schemaVersion: 1,
      revision: 3,
      config: { participants: ['codex', 'claude'] },
      session: {
        id: '00000000-0000-4000-8000-000000000001',
        status: 'active',
        deadlineAt: new Date(Date.now() + 60000).toISOString(),
        claims: [{ agent: 'codex', path: 'a.js', expiresAt: Date.now() + 1000 }],
        candidates: [{ id: 'm1', agent: 'codex', files: [{ path: 'a.js', sha256: 'x' }] }],
        messages: [],
      },
    }),
  );
  const state = await new Collaboration(root).status();
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.session.status, 'stopped');
  assert.match(state.session.stopReason, /upgraded/);
  assert.equal(state.session.claims, undefined);
  assert.deepEqual(state.session.candidates[0].changes, []);
});

test('wait observes peer revisions and terminal status; a blocker stops both peers', async (t) => {
  const { collab } = await fixture(t);
  const before = await collab.status('claude');
  const waiting = collab.wait('claude', before.revision, 2000);
  await collab.post(
    'codex',
    message('blocked', { summary: 'Required source is unavailable', evidence: [] }),
  );
  const result = await waiting;
  assert.equal(result.session.status, 'blocked');
  assert.equal(result.session.nextAction, 'stop');
  assert.equal(result.session.stopReason, 'Required source is unavailable');
  await assert.rejects(collab.wait('claude', -2, 1), /revision/);
});

test('only listed dependency directories are linked; other ignored paths stay private', async (t) => {
  const root = await gitProject(t, 'model-collab-links-', {
    '.gitignore': 'node_modules/\nbuild/\n.env\ntarget/\n.collab/\n',
    'packages/app/index.js': 'app\n',
  });
  for (const dir of ['node_modules/dep', 'packages/app/node_modules/lib', 'build', 'target'])
    await fs.mkdir(path.join(root, dir), { recursive: true });
  await fs.writeFile(path.join(root, 'build/out.js'), 'built\n');
  await fs.writeFile(path.join(root, 'node_modules/dep/index.js'), 'dep\n');
  await fs.writeFile(path.join(root, 'packages/app/node_modules/lib/index.js'), 'lib\n');
  await fs.writeFile(path.join(root, 'target/out'), 'binary\n');
  await fs.writeFile(path.join(root, '.env'), 'SECRET=1\n');
  const collab = new Collaboration(root);
  await collab.init();
  await collab.start({ topic: 'Check links.' });
  const ws = await workspace(collab, 'codex');
  assert.ok((await fs.lstat(path.join(ws, 'node_modules'))).isSymbolicLink());
  assert.ok((await fs.lstat(path.join(ws, 'packages/app/node_modules'))).isSymbolicLink());
  for (const privatePath of ['build', 'target', '.env'])
    await assert.rejects(fs.lstat(path.join(ws, privatePath)), { code: 'ENOENT' });
  await collab.stop('Reconfigure.');
  await collab.configure({ dependencyDirs: [] });
  await collab.start({ topic: 'No links.' });
  await assert.rejects(fs.lstat(path.join(await workspace(collab, 'codex'), 'node_modules')), {
    code: 'ENOENT',
  });
  await assert.rejects(collab.configure({ dependencyDirs: ['../escape'] }));
});

async function agreed(t, files, change) {
  const { root, collab } = await fixture(t, {}, files);
  await change(await workspace(collab, 'codex'));
  const [candidate] = await independent(collab);
  return { root, collab, candidate };
}

test('apply refuses a candidate whose parent directory is now a user file, writing nothing', async (t) => {
  const { root, collab, candidate } = await agreed(t, { 'a.txt': 'old a\n' }, async (ws) => {
    await fs.writeFile(path.join(ws, 'a.txt'), 'new a\n');
    await fs.mkdir(path.join(ws, 'src/utils'), { recursive: true });
    await fs.writeFile(path.join(ws, 'src/utils/helpers.js'), 'helpers\n');
  });
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/utils'), 'unrelated user file\n');
  const result = await collab.post('claude', message('accept', { candidate }));
  assert.match(result.applied.error, /you changed src\/utils/);
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'old a\n');
  assert.equal(await fs.readFile(path.join(root, 'src/utils'), 'utf8'), 'unrelated user file\n');
});

test('a write failure during apply restores the files already written', async (t) => {
  const { root, collab, candidate } = await agreed(
    t,
    { 'a.txt': 'old a\n', 'locked/b.txt': 'old b\n' },
    async (ws) => {
      await fs.writeFile(path.join(ws, 'a.txt'), 'new a\n');
      await fs.writeFile(path.join(ws, 'locked/b.txt'), 'new b\n');
    },
  );
  await fs.chmod(path.join(root, 'locked'), 0o555);
  const result = await collab
    .post('claude', message('accept', { candidate }))
    .finally(() => fs.chmod(path.join(root, 'locked'), 0o755));
  assert.match(result.applied.error, /left as it was/);
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'old a\n');
  assert.equal(await fs.readFile(path.join(root, 'locked/b.txt'), 'utf8'), 'old b\n');
  assert.equal((await collab.status()).session.applyLog.length, 1);
});

test('apply treats a user permission change as a conflict and applies executable-bit changes', async (t) => {
  const conflict = await agreed(t, { 'run.sh': 'echo old\n' }, (ws) =>
    fs.writeFile(path.join(ws, 'run.sh'), 'echo new\n'),
  );
  await fs.chmod(path.join(conflict.root, 'run.sh'), 0o755);
  const refused = await conflict.collab.post(
    'claude',
    message('accept', { candidate: conflict.candidate }),
  );
  assert.match(refused.applied.error, /you changed run.sh/);
  assert.equal((await fs.stat(path.join(conflict.root, 'run.sh'))).mode & 0o111, 0o111);
  const modeOnly = await agreed(t, { 'run.sh': 'echo same\n' }, (ws) =>
    fs.chmod(path.join(ws, 'run.sh'), 0o755),
  );
  const applied = await modeOnly.collab.post(
    'claude',
    message('accept', { candidate: modeOnly.candidate }),
  );
  assert.deepEqual(applied.applied.files, ['run.sh']);
  assert.notEqual((await fs.stat(path.join(modeOnly.root, 'run.sh'))).mode & 0o111, 0);
});

test('apply can replace a file with a directory of the same name', async (t) => {
  const { root, collab, candidate } = await agreed(t, { utils: 'old module\n' }, async (ws) => {
    await fs.rm(path.join(ws, 'utils'));
    await fs.mkdir(path.join(ws, 'utils'));
    await fs.writeFile(path.join(ws, 'utils/index.js'), 'new module\n');
  });
  const result = await collab.post('claude', message('accept', { candidate }));
  assert.deepEqual(result.applied.files, ['utils', 'utils/index.js']);
  assert.equal(await fs.readFile(path.join(root, 'utils/index.js'), 'utf8'), 'new module\n');
});

test('review checkouts are removed when the session ends', async (t) => {
  const { collab } = await fixture(t);
  const [candidate] = await independent(collab);
  const review = await collab.checkout('claude', candidate);
  await assert.doesNotReject(fs.access(review.path));
  await collab.stop('Done reviewing.');
  await assert.rejects(fs.access(path.join(collab.dir, 'review')), { code: 'ENOENT' });
});
