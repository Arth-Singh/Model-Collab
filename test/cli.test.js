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
  clientMessageId: randomUUID(),
  contextVersion: 0,
  kind,
  summary: 'Review the current goal.',
  evidence: ['Checked the current goal and candidate.'],
  ...extra,
});

test('project setup and controls provide readable output while preserving JSON automation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-collab-onboarding-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = async (...args) => {
    const result = await runCommand([process.execPath, cli, ...args, '--repo', root], {
      cwd: root,
    });
    assert.equal(result.code, 0, result.stderr);
    return result.stdout;
  };
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'Existing project rules.\n');
  assert.match(await run('init', '--preset', 'research'), /Research brief: .collab\/RESEARCH.md/);
  assert.equal(
    await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'),
    'Existing project rules.\n',
  );
  const changed = JSON.parse(
    await run('configure', '--minutes', '45', '--max-rounds', '6', '--json'),
  );
  assert.equal(changed.deadlineMinutes, 45);
  assert.equal(changed.maxRounds, 6);
  assert.match(await run('start', 'Inspect the project.'), /Goal: Inspect the project/);
  const denied = await runCommand([
    process.execPath,
    cli,
    'configure',
    '--minutes',
    '30',
    '--repo',
    root,
  ]);
  assert.notEqual(denied.code, 0);
  assert.match(denied.stderr, /Stop the current/);
  assert.match(await run('status', '--human'), /Status: active/);
  assert.equal(JSON.parse(await run('status')).session.status, 'active');
  assert.match(await run('pause'), /Collaboration paused/);
  const note = JSON.parse(await run('note', 'Keep the public API.', '--json'));
  assert.equal(note.session.contextVersion, 1);
  assert.match(await run('resume'), /Collaboration resumed/);
  assert.match(await run('stop'), /Collaboration stopped/);
  assert.equal(JSON.parse(await run('configure', '--preset', 'coding', '--json')).preset, 'coding');
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-collab-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const collab = new Collaboration(root);
  await collab.init();
  const state = await collab.start({ topic: 'Goal A' });
  const post = (body, sessionId = state.session.id) =>
    runCommand(
      [
        process.execPath,
        cli,
        'post',
        '--repo',
        root,
        '--agent',
        'codex',
        ...(sessionId === null ? [] : ['--session', sessionId]),
        '--json',
        '-',
      ],
      { cwd: root, input: JSON.stringify(body) },
    );
  return { collab, sessionId: state.session.id, post };
}

test('CLI post requires a nonempty, valid observed session ID without mutating state', async (t) => {
  const { collab, post } = await fixture(t);
  const before = await fs.readFile(collab.file, 'utf8');
  for (const sessionId of [null, '', 'not-a-session-id']) {
    const result = await post(message(), sessionId);
    assert.notEqual(result.code, 0, `Accepted invalid session ID: ${sessionId}`);
    assert.match(result.stderr, /session|UUID/i);
    assert.equal(await fs.readFile(collab.file, 'utf8'), before);
  }
});

test('CLI posts with the observed session remain retry-safe', async (t) => {
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

test('CLI rejects a stale proposal when the replacement goal has the same context version', async (t) => {
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

test('CLI rejects a stale acceptance despite reused candidate IDs and allows a current vote', async (t) => {
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
