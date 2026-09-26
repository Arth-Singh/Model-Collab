import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Collaboration } from '../src/core.js';
import { gitProject } from './helpers.js';

const body = (kind = 'proposal', extra = {}) => ({
  clientMessageId: randomUUID(),
  kind,
  summary: 'Strict comparison respects half-open boundaries.',
  evidence: ['Adjacent intervals do not overlap.'],
  ...(kind === 'proposal' ? { solution: 'Use max(start) < min(end).' } : {}),
  ...extra,
});

async function fixture(t, config = {}) {
  const root = await gitProject(t, 'model-collab-interactive-');
  const collab = new Collaboration(root);
  await collab.init(config);
  await collab.start({ topic: 'Implement interval intersection.' });
  return { root, collab };
}

test('pause blocks new work and replacement and preserves independent sealing', async (t) => {
  const { collab } = await fixture(t, {
    checks: { unit: [process.execPath, '-e', 'process.exit(0)'] },
  });
  const first = await collab.post('codex', body('proposal'));
  await collab.pause();
  const state = await collab.status('claude');
  assert.equal(state.session.status, 'paused');
  assert.deepEqual(state.session.messages, []);
  assert.deepEqual(state.session.candidates, []);
  await assert.rejects(collab.checkout('claude', first.message.id), /Unknown candidate/);
  await assert.rejects(collab.post('claude', body()), /paused/);
  await assert.rejects(collab.verify('codex', first.message.id, 'unit'), /paused/);
  await assert.rejects(collab.start({ topic: 'Must not replace a paused goal.' }), /paused/);
  await collab.stop('User stopped while paused.');
  assert.equal((await collab.status()).session.status, 'stopped');
});

test('resume restores remaining deadline time even after the original deadline passes', async (t) => {
  const { collab } = await fixture(t);
  await collab.pause();
  const pausedAt = Date.now() - 10000;
  const oldDeadline = pausedAt + 5000;
  await collab.transaction((state) => {
    state.session.pausedAt = new Date(pausedAt).toISOString();
    state.session.deadlineAt = new Date(oldDeadline).toISOString();
  });
  assert.equal((await collab.status()).session.status, 'paused');
  const resumed = await collab.resume();
  assert.equal(resumed.session.status, 'active');
  assert.equal(resumed.session.pausedAt, undefined);
  const remaining = Date.parse(resumed.session.deadlineAt) - Date.now();
  assert.ok(
    remaining > 4500 && remaining <= 5000,
    `Expected frozen remaining budget, got ${remaining} ms`,
  );
  await assert.rejects(collab.resume(), /not paused/);
});

test('human notes invalidate votes and checks and require explicit current-context acknowledgement', async (t) => {
  const { root, collab } = await fixture(t, {
    checks: { unit: [process.execPath, '-e', 'process.exit(0)'] },
  });
  const first = await collab.post('codex', body('proposal'));
  await collab.post('claude', body());
  await collab.verify('codex', first.message.id, 'unit');
  await collab.post('codex', body('accept', { candidate: first.message.id }));
  await collab.pause();
  await collab.note('Also handle empty intervals explicitly.');
  const noted = await collab.status('codex');
  assert.equal(noted.session.status, 'paused');
  assert.equal(noted.session.contextVersion, 1);
  assert.deepEqual(noted.session.votes, {});
  assert.deepEqual(noted.session.checks, []);
  assert.equal(noted.session.humanNotes[0].text, 'Also handle empty intervals explicitly.');
  await collab.resume();
  await assert.rejects(collab.post('claude', body('evidence')), /Shared context changed/);
  await assert.rejects(
    collab.post('claude', body('evidence', { contextVersion: 0 })),
    /Shared context changed/,
  );
  await assert.rejects(
    collab.post('claude', body('accept', { contextVersion: 1, candidate: first.message.id })),
    /Required checks/,
  );
  await collab.post(
    'codex',
    body('evidence', {
      contextVersion: 1,
      summary: 'Reviewed the new empty-interval requirement.',
    }),
  );
  await collab.post(
    'claude',
    body('evidence', { contextVersion: 1, summary: 'Added an empty interval counterexample.' }),
  );
  const after = await collab.status();
  assert.equal(after.session.round, 2);
  assert.deepEqual(
    after.session.messages.slice(-2).map((message) => message.contextVersion),
    [1, 1],
  );
  assert.match(
    await fs.readFile(path.join(root, '.collab', 'README.md'), 'utf8'),
    /User note · context 1/,
  );
});

test('a human note invalidates a verification already running', { timeout: 5000 }, async (t) => {
  // Checks run in a temporary checkout, so the handshake files live elsewhere.
  const signals = await fs.mkdtemp(path.join(os.tmpdir(), 'model-collab-signals-'));
  t.after(() => fs.rm(signals, { recursive: true, force: true }));
  const started = path.join(signals, 'check.started'),
    finish = path.join(signals, 'check.finish');
  const script = `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(started)},"yes");const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(finish)})){clearInterval(timer);process.exit(0)}},10);`;
  const { collab } = await fixture(t, { checks: { unit: [process.execPath, '-e', script] } });
  const first = await collab.post('codex', body('proposal'));
  const checking = assert.rejects(
    collab.verify('codex', first.message.id, 'unit'),
    /Shared context changed/,
  );
  let running = false;
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        await fs.access(started);
        running = true;
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(running, 'Check must be running before the note arrives');
    await collab.note('Additional acceptance requirement arrived during verification.');
  } finally {
    await fs.writeFile(finish, 'yes');
  }
  await checking;
  assert.deepEqual((await collab.status()).session.checks, []);
});

test(
  'awaitTurn ignores review and verification activity until the peer advances the round',
  { timeout: 5000 },
  async (t) => {
    const { collab } = await fixture(t, {
      checks: { unit: [process.execPath, '-e', 'process.exit(0)'] },
    });
    const first = await collab.post('codex', body('proposal'));
    let settled = false;
    const waiting = collab.awaitTurn('codex', 2000).then((state) => {
      settled = true;
      return state;
    });
    await collab.checkout('codex', first.message.id);
    await collab.verify('codex', first.message.id, 'unit');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(settled, false);
    await collab.post('claude', body());
    const result = await waiting;
    assert.equal(result.session.round, 1);
    assert.equal(result.session.nextAction, 'cross-examine the candidates, then send one message');
  },
);

test(
  'awaitTurn returns for pause, terminal state, new human context, timeout and cancellation',
  { timeout: 5000 },
  async (t) => {
    for (const action of ['pause', 'stop', 'note', 'timeout', 'abort']) {
      const { collab } = await fixture(t);
      await collab.post('codex', body());
      const controller = new AbortController();
      const waiting = collab.awaitTurn(
        'codex',
        action === 'timeout' ? 10 : 2000,
        controller.signal,
      );
      if (action === 'pause') await collab.pause();
      if (action === 'stop') await collab.stop('Human ended the goal.');
      if (action === 'note')
        await collab.note('New requirement makes another contribution actionable.');
      if (action === 'abort') controller.abort();
      const result = await waiting;
      if (action === 'pause' || action === 'stop')
        assert.equal(result.session.status, action === 'pause' ? 'paused' : 'stopped');
      else if (action === 'note') {
        assert.equal(result.session.contextVersion, 1);
        assert.equal(
          result.session.nextAction,
          'solve independently in your workspace, then propose',
        );
      } else assert.equal(result.session.nextAction, 'wait');
    }
  },
);
