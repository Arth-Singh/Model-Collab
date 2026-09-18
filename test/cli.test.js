import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Collaboration } from '../src/core.js';
import { runCommand } from '../src/process.js';

const cli = fileURLToPath(new URL('../bin/model-collab.js', import.meta.url));
const message = (kind = 'proposal', extra = {}) => ({
  clientMessageId: randomUUID(), contextVersion: 0, kind,
  summary: 'Review the current goal.', evidence: ['Checked the current goal and candidate.'], ...extra,
});

test('CLI evaluation planning and insufficient budgets never invoke providers or write artifacts', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-collab-plan-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, 'provider-called');
  const script = `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called'); process.exit(1);\n`;
  for (const name of ['codex', 'claude']) await fs.writeFile(path.join(root, name), script, { mode: 0o700 });
  const invoke = args => runCommand([process.execPath, cli, 'eval', '--suite', 'rl', '--tasks', 'rl-gae-boundaries', '--output', path.join(root, 'results'), ...args], { cwd: root, env: { ...process.env, PATH: root } });
  const planned = await invoke(['--max-calls', '16', '--plan']);
  assert.equal(planned.code, 0, planned.stderr);
  const manifest = JSON.parse(planned.stdout);
  assert.equal(manifest.config.plannedCalls, 16);
  assert.equal(manifest.config.effort, 'xhigh');
  assert.deepEqual(manifest.config.modes, ['solo-codex', 'solo-claude', 'independent-pair', 'collaboration']);
  const rejected = await invoke(['--max-calls', '15']);
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.stderr, /cover all 16 planned calls/);
  assert.deepEqual((await fs.readdir(root)).sort(), ['claude', 'codex']);
});

test('CLI evaluation saves readable results and an unpublished draft using only fixture providers', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-collab-report-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const response = JSON.stringify({ solution: 'function solve() { return null; }', summary: 'Intentionally incorrect fixture output.' });
  await fs.writeFile(path.join(root, 'codex'), `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message') + 1], ${JSON.stringify(response)});\nconsole.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:10,cached_input_tokens:0}}));\n`, { mode: 0o700 });
  const result = await runCommand([process.execPath, cli, 'eval', '--suite', 'rl', '--tasks', 'rl-gae-boundaries', '--modes', 'solo-codex', '--calls', '2', '--max-calls', '2', '--output', path.join(root, 'results')], { cwd: root, env: { ...process.env, PATH: root } });
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const report = JSON.parse(await fs.readFile(output.artifactPath, 'utf8'));
  assert.equal(report.counters.attempted, 2);
  assert.equal(report.counters.launched, 2);
  assert.equal(report.results[0].outcome, 'incorrect');
  assert.equal(report.results[0].executionStatus, 'complete');
  assert.match(await fs.readFile(output.reportPath, 'utf8'), /solo-codex/);
  assert.match(await fs.readFile(output.draftPath, 'utf8'), /DRAFT — not posted/);
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-collab-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const collab = new Collaboration(root);
  await collab.init();
  const state = await collab.start({ topic: 'Goal A' });
  const post = (body, sessionId = state.session.id) => runCommand([
    process.execPath, cli, 'post', '--repo', root, '--agent', 'codex',
    ...(sessionId === null ? [] : ['--session', sessionId]), '--json', '-',
  ], { cwd: root, input: JSON.stringify(body) });
  return { collab, sessionId: state.session.id, post };
}

test('CLI post requires a nonempty, valid observed session ID without mutating state', async t => {
  const { collab, post } = await fixture(t);
  const before = await fs.readFile(collab.file, 'utf8');
  for (const sessionId of [null, '', 'not-a-session-id']) {
    const result = await post(message(), sessionId);
    assert.notEqual(result.code, 0, `Accepted invalid session ID: ${sessionId}`);
    assert.match(result.stderr, /session|UUID/i);
    assert.equal(await fs.readFile(collab.file, 'utf8'), before);
  }
});

test('CLI posts with the observed session remain retry-safe', async t => {
  const { collab, post } = await fixture(t);
  const body = message();
  const first = await post(body);
  assert.equal(first.code, 0, first.stderr);
  const original = JSON.parse(first.stdout);
  const before = await fs.readFile(collab.file, 'utf8');
  const retry = await post(body);
  assert.equal(retry.code, 0, retry.stderr);
  assert.equal(JSON.parse(retry.stdout).duplicate, true);
  assert.deepEqual(JSON.parse(retry.stdout).message, original.message);
  assert.equal(await fs.readFile(collab.file, 'utf8'), before);
  const conflict = await post({ ...body, summary: 'Different content under the same retry ID.' });
  assert.notEqual(conflict.code, 0);
  assert.match(conflict.stderr, /different content/);
  assert.equal(await fs.readFile(collab.file, 'utf8'), before);
});

test('CLI rejects a stale proposal when the replacement goal has the same context version', async t => {
  const { collab, sessionId, post } = await fixture(t);
  const stale = message();
  await collab.stop('Replace the goal.');
  const replacement = await collab.start({ topic: 'Goal B' });
  assert.notEqual(replacement.session.id, sessionId);
  assert.equal(replacement.session.contextVersion, stale.contextVersion);
  const before = await fs.readFile(collab.file, 'utf8');
  const rejected = await post(stale);
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.stderr, /Active session changed/);
  assert.equal(await fs.readFile(collab.file, 'utf8'), before);
  const accepted = await post(stale, replacement.session.id);
  assert.equal(accepted.code, 0, accepted.stderr);
});

test('CLI rejects a stale acceptance despite reused candidate IDs and allows a current vote', async t => {
  const { collab, post } = await fixture(t);
  const old = await collab.post('codex', message());
  await collab.post('claude', message());
  const staleVote = message('accept', { candidate: old.message.id });
  await collab.stop('Replace the goal before the prepared vote arrives.');
  const replacement = await collab.start({ topic: 'Goal B' });
  const current = await collab.post('codex', message());
  await collab.post('claude', message());
  assert.equal(old.message.id, current.message.id);
  const before = await fs.readFile(collab.file, 'utf8');
  const rejected = await post(staleVote);
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.stderr, /Active session changed/);
  assert.equal(await fs.readFile(collab.file, 'utf8'), before);
  const currentVote = message('accept', { candidate: current.message.id });
  const accepted = await post(currentVote, replacement.session.id);
  assert.equal(accepted.code, 0, accepted.stderr);
  const final = await collab.post('claude', message('accept', { candidate: current.message.id }));
  assert.equal(final.status, 'converged');
  const retry = await post(currentVote, replacement.session.id);
  assert.equal(retry.code, 0, retry.stderr);
  assert.equal(JSON.parse(retry.stdout).duplicate, true);
});
