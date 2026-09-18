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

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/model-collab.js', import.meta.url));
let serial = 0;
const message = (kind, extra = {}) => ({
  clientMessageId: `test-message-${++serial}`, kind, summary: `${kind} backed by a check`,
  evidence: ['Boundary example produces the expected result.'], ...extra,
});

async function fixture(t, config = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-collab-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const collab = new Collaboration(root);
  await collab.init(config);
  await collab.start({ topic: 'Implement a correct interval intersection.', successCriteria: ['Adjacent intervals do not overlap.'] });
  return { root, collab };
}

async function independent(collab, extra = {}) {
  const first = await collab.post('codex', message('proposal', extra));
  const second = await collab.post('claude', message('proposal'));
  return [first.message.id, second.message.id];
}

test('independent proposals remain sealed until every peer submits; each peer gets one contribution per round', async t => {
  const { collab } = await fixture(t);
  await assert.rejects(collab.post('codex', message('evidence')), /independent proposal/);
  const own = await collab.post('codex', message('proposal', { solution: 'max(start) < min(end)' }));
  const sealed = await collab.status('claude');
  assert.equal(sealed.session.phase, 'independent');
  assert.deepEqual(sealed.session.messages, []);
  assert.deepEqual(sealed.session.candidates, []);
  assert.deepEqual(sealed.session.independentPeersPending, ['claude']);
  assert.equal((await collab.status('codex')).session.messages[0].id, own.message.id);
  await assert.rejects(collab.post('codex', message('proposal')), /already contributed/);
  await collab.post('claude', message('proposal'));
  const shared = await collab.status('claude');
  assert.equal(shared.session.phase, 'discussion');
  assert.equal(shared.session.round, 1);
  assert.equal(shared.session.messages.length, 2);
  await collab.post('claude', message('evidence'));
  await assert.rejects(collab.post('claude', message('evidence')), /already contributed/);
});

test('agreement requires every participant to explicitly accept the same candidate', async t => {
  const { collab } = await fixture(t, { participants: ['codex', 'claude', 'reviewer'] });
  const first = await collab.post('codex', message('proposal'));
  await collab.post('claude', message('proposal'));
  await collab.post('reviewer', message('proposal'));
  const candidate = first.message.id;
  assert.equal((await collab.post('claude', message('accept', { candidate }))).status, 'active');
  assert.equal((await collab.post('codex', message('accept', { candidate }))).status, 'active');
  const result = await collab.post('reviewer', message('accept', { candidate }));
  assert.equal(result.status, 'converged');
  assert.equal(result.winner, candidate);
  await assert.rejects(collab.post('codex', message('evidence')), /converged/);
});

test('different accepted candidates do not converge; a new proposal clears prior votes', async t => {
  const { collab } = await fixture(t);
  const [a, b] = await independent(collab);
  await collab.post('codex', message('accept', { candidate: a }));
  await collab.post('claude', message('accept', { candidate: b }));
  assert.equal((await collab.status()).session.status, 'active');
  const replacement = await collab.post('codex', message('proposal', { summary: 'Revised candidate incorporates both boundary cases.' }));
  const s = (await collab.status()).session;
  assert.deepEqual(s.votes, {});
  assert.equal(s.candidates.find(c => c.id === a).supersededBy, replacement.message.id);
  await assert.rejects(collab.post('claude', message('accept', { candidate: a })), /superseded/);
});

test('open challenges block acceptance and only their author can close them', async t => {
  const { collab } = await fixture(t);
  const [candidate] = await independent(collab);
  const challenge = await collab.post('claude', message('challenge', { candidate }));
  await assert.rejects(collab.post('codex', message('accept', { candidate })), /open challenges/);
  await assert.rejects(collab.post('codex', message('evidence', { resolves: [challenge.message.id] })), /original challenger/);
  await collab.post('codex', message('evidence', { repliesTo: challenge.message.id }));
  await collab.post('claude', message('accept', { candidate, resolves: [challenge.message.id] }));
  const final = await collab.post('codex', message('accept', { candidate }));
  assert.equal(final.status, 'converged');
  assert.ok((await collab.status()).session.challenges[0].resolvedBy);
});

test('required checks and current artifact hashes gate acceptance', async t => {
  const { root, collab } = await fixture(t, {
    checks: { unit: [process.execPath, '-e', 'if(require("node:fs").readFileSync("answer.txt","utf8")!=="correct")process.exit(2)'] },
  });
  await fs.writeFile(path.join(root, 'answer.txt'), 'wrong');
  const [candidate] = await independent(collab, { files: ['answer.txt'] });
  await assert.rejects(collab.post('codex', message('accept', { candidate })), /Required checks/);
  assert.equal((await collab.verify('claude', candidate, 'unit')).passed, false);
  await assert.rejects(collab.post('codex', message('accept', { candidate })), /Required checks/);
  await fs.writeFile(path.join(root, 'answer.txt'), 'correct');
  await assert.rejects(collab.verify('codex', candidate, 'unit'), /files changed/);
  await assert.rejects(collab.post('codex', message('accept', { candidate })), /files changed/);
  const replacement = await collab.post('codex', message('proposal', { files: ['answer.txt'] }));
  await collab.post('claude', message('evidence'));
  const fresh = replacement.message.id;
  assert.equal((await collab.verify('claude', fresh, 'unit')).passed, true);
  await collab.post('codex', message('accept', { candidate: fresh }));
  await fs.writeFile(path.join(root, 'answer.txt'), 'changed after first acceptance');
  await assert.rejects(collab.post('claude', message('accept', { candidate: fresh })), /files changed/);
});

test('checks that modify a proposed artifact cannot certify the stale candidate', async t => {
  const { root, collab } = await fixture(t, {
    checks: { mutate: [process.execPath, '-e', 'require("node:fs").writeFileSync("answer.txt","modified")'] },
  });
  await fs.writeFile(path.join(root, 'answer.txt'), 'original');
  const [candidate] = await independent(collab, { files: ['answer.txt'] });
  await assert.rejects(collab.verify('codex', candidate, 'mutate'), /files changed/);
  assert.deepEqual((await collab.status()).session.checks, []);
});

test('identical retries are idempotent, conflicting retries fail, and invalid input leaves state unchanged', async t => {
  const { collab } = await fixture(t);
  const body = message('proposal');
  const original = await collab.post('codex', body);
  const before = await collab.status();
  const retry = await collab.post('codex', body);
  assert.equal(retry.duplicate, true);
  assert.deepEqual(retry.message, original.message);
  await assert.rejects(collab.post('codex', { ...body, summary: 'Different answer' }), /different content/);
  await assert.rejects(collab.post('claude', message('proposal', { evidence: [] })), /Provide evidence/);
  await assert.rejects(collab.post('unknown', message('proposal')), /Unknown participant/);
  await assert.rejects(collab.post('claude', { ...message('proposal'), unsupported: true }));
  assert.deepEqual(await collab.status(), before);
});

test('process locking preserves simultaneous proposals and rejects racing duplicate turns', async t => {
  const { root, collab } = await fixture(t);
  const sessionId = (await collab.status('codex')).session.id;
  const post = (agent, body) => execFileAsync(process.execPath, [cli, 'post', '--repo', root, '--agent', agent, '--session', sessionId, '--json', JSON.stringify(body)]);
  await Promise.all([post('codex', message('proposal')), post('claude', message('proposal'))]);
  const first = await collab.status();
  assert.equal(first.session.messages.length, 2);
  assert.equal(first.session.round, 1);
  const racing = await Promise.allSettled([post('codex', message('evidence')), post('codex', message('evidence'))]);
  assert.equal(racing.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(racing.filter(r => r.status === 'rejected').length, 1);
  assert.equal((await collab.status()).session.messages.length, 3);
  await assert.doesNotReject(fs.readFile(path.join(root, '.collab', 'state.json'), 'utf8').then(JSON.parse));
});

test('message and discussion-round limits stop debate without inventing a winner', async t => {
  for (const [config, reason] of [[{ maxMessages: 4 }, 'message_limit'], [{ maxRounds: 1 }, 'round_limit']]) {
    const { collab } = await fixture(t, config);
    await independent(collab);
    await collab.post('codex', message('evidence'));
    const result = await collab.post('claude', message('evidence'));
    assert.equal(result.status, 'exhausted');
    const state = await collab.status();
    assert.equal(state.session.stopReason, reason);
    assert.equal(state.session.winner, null);
    await assert.rejects(collab.post('codex', message('proposal')), /exhausted/);
  }
});

test('deadline expiry persists even when the triggering write is rejected', async t => {
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

test('claims reject overlap, traversal and escaping symlinks; release and expiry free paths', async t => {
  const { root, collab } = await fixture(t);
  await collab.claim('codex', ['src']);
  await assert.rejects(collab.claim('claude', ['src/index.js']), /claimed by codex/);
  await assert.rejects(collab.claim('claude', ['../outside']), /relative/);
  await assert.rejects(collab.claim('claude', ['/tmp/outside']), /relative/);
  await assert.rejects(collab.claim('claude', ['.git/config']), /metadata/);
  await assert.rejects(collab.claim('claude', ['.collab/state.json']), /metadata/);
  await fs.symlink(os.tmpdir(), path.join(root, 'escape'));
  await assert.rejects(collab.claim('claude', ['escape/new.js']), /Symlink escapes/);
  await collab.release('codex');
  await collab.claim('claude', ['src/index.js']);
  await assert.rejects(collab.claim('codex', ['src']), /claimed by claude/);
  const file = path.join(root, '.collab', 'state.json');
  const state = JSON.parse(await fs.readFile(file, 'utf8'));
  state.session.claims[0].expiresAt = Date.now() - 1;
  await fs.writeFile(file, JSON.stringify(state));
  assert.equal((await collab.claim('codex', ['src'])).length, 1);
});

test('symlink aliases cannot bypass path claims or reserved metadata protection', async t => {
  const { root, collab } = await fixture(t);
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'answer.js'), 'export default 42;');
  await fs.symlink('src', path.join(root, 'alias'));
  await collab.claim('codex', ['src/answer.js']);
  await assert.rejects(collab.claim('claude', ['alias/answer.js']), /claimed by codex/);
  await collab.release('codex', ['./src/answer.js']);
  assert.deepEqual((await collab.status()).session.claims, []);
  await collab.claim('codex', ['alias/answer.js']);
  await collab.release('codex', ['alias/answer.js']);
  assert.deepEqual((await collab.status()).session.claims, []);
  await fs.symlink('.collab', path.join(root, 'state-alias'));
  await assert.rejects(collab.claim('claude', ['state-alias/state.json']), /metadata/);
  await assert.rejects(collab.snapshot(['state-alias/state.json']), /metadata/);
  await fs.symlink('.', path.join(root, 'self'));
  await assert.rejects(collab.claim('claude', ['self']), /metadata|repository root/);
});

test('equivalent file spellings produce one stable artifact snapshot', async t => {
  const { root, collab } = await fixture(t);
  await fs.writeFile(path.join(root, 'answer.txt'), 'correct');
  const [candidate] = await independent(collab, { files: ['answer.txt', './answer.txt'] });
  assert.equal((await collab.status()).session.candidates[0].files.length, 1);
  await assert.doesNotReject(collab.post('codex', message('accept', { candidate })));
});

test('semantic duplicates and repeated votes cannot prolong a discussion', async t => {
  const { collab } = await fixture(t);
  const [candidate] = await independent(collab);
  const evidence = message('evidence', { summary: 'Exhaustively checked endpoints from 0 to 5.' });
  await collab.post('claude', evidence);
  await collab.post('codex', message('accept', { candidate }));
  await assert.rejects(collab.post('claude', { ...evidence, clientMessageId: 'another-message-id' }), /Repeated contribution/);
  await assert.rejects(collab.post('codex', message('accept', { candidate, summary: 'Still agree' })), /already accepted/);
  assert.equal((await collab.status()).session.messages.length, 4);
});

test('start, stop and restart archive prior sessions and preserve user context', async t => {
  const { root, collab } = await fixture(t);
  const original = await collab.status();
  await assert.rejects(collab.init(), /Already initialized/);
  await assert.rejects(collab.start({ topic: 'Overlapping session' }), /already active/);
  await collab.claim('codex', ['src/answer.js']);
  await writeInstructions(root, ['codex', 'claude']);
  await fs.writeFile(path.join(root, '.collab', 'CONTEXT.md'), 'User-owned context');
  await writeInstructions(root, ['codex', 'claude']);
  assert.equal(await fs.readFile(path.join(root, '.collab', 'CONTEXT.md'), 'utf8'), 'User-owned context');
  await collab.stop('User paused this experiment');
  assert.deepEqual((await collab.status()).session.claims, []);
  const next = await collab.start({ topic: 'A new user-requested goal' });
  assert.notEqual(next.session.id, original.session.id);
  const archived = JSON.parse(await fs.readFile(path.join(root, '.collab', 'history', `${original.session.id}.json`), 'utf8'));
  assert.equal(archived.status, 'stopped');
  assert.equal(archived.stopReason, 'User paused this experiment');
  const codex = await launch(root, 'codex', { print: true });
  const claude = await launch(root, 'claude', { print: true });
  assert.equal(codex.cwd, root);
  assert.ok(codex.args.some(arg => arg.includes('mcp_servers.model_collab')));
  assert.ok(claude.args.includes('--mcp-config'));
});

test('wait observes peer revisions and terminal status; a blocker stops both peers', async t => {
  const { collab } = await fixture(t);
  const before = await collab.status('claude');
  const waiting = collab.wait('claude', before.revision, 2000);
  await collab.post('codex', message('blocked', { summary: 'Required source is unavailable', evidence: [] }));
  const result = await waiting;
  assert.equal(result.session.status, 'blocked');
  assert.equal(result.session.nextAction, 'stop');
  assert.equal(result.session.stopReason, 'Required source is unavailable');
  await assert.rejects(collab.wait('claude', -2, 1), /revision/);
});

test('verification cannot certify a text-only proposal or run an inherited check name', async t => {
  const { collab } = await fixture(t, { checks: { unit: [process.execPath, '-e', 'process.exit(0)'] } });
  const id = (await collab.post('codex', message('proposal'))).message.id;
  await assert.rejects(collab.verify('codex', id, 'unit'), /file-backed proposal/);
  await assert.rejects(collab.verify('codex', id, 'constructor'), /Unknown check/);
});
