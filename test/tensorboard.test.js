import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventWriter, crc32c } from '../src/tensorboard.js';
import { parseScore, runLabel, tensorboardDir } from '../src/monitor.js';
import { readEvents } from './helpers.js';

test('CRC-32C matches the standard check value', () => {
  assert.equal(crc32c(Buffer.from('123456789')), 0xe3069283);
});

test('the writer produces TFRecord events TensorBoard can read', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-collab-tb-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const writer = new EventWriter(path.join(dir, 'run'));
  writer.scalars({ 'main/commits': 0, 'tokens/total': 1500 }, 0, 1000);
  writer.scalars({ 'main/commits': 3, 'tokens/total': 2.5e6, skipped: NaN }, 300, 1300);
  writer.close();
  writer.close();
  const [file] = await fs.readdir(path.join(dir, 'run'));
  assert.match(file, /^events\.out\.tfevents\.\d+\./);
  const events = await readEvents(path.join(dir, 'run', file));
  assert.equal(events[0].fileVersion, 'brain.Event:2');
  assert.deepEqual(
    events.slice(1).map((e) => [e.step ?? 0, e.wallTime, e.scalars]),
    [
      [0, 1000, { 'main/commits': 0, 'tokens/total': 1500 }],
      [300, 1300, { 'main/commits': 3, 'tokens/total': 2.5e6 }],
    ],
  );
});

test('scores are read from the last fraction or number a command prints', () => {
  assert.deepEqual(parseScore('PASS a\nFAIL b\nSCORE 17/24\n'), { score: 17, fraction: 17 / 24 });
  assert.deepEqual(parseScore('Ran 40 tests\nOK 38 passed'), { score: 38, fraction: null });
  assert.deepEqual(parseScore('1/2 then 3 / 4'), { score: 3, fraction: 0.75 });
  assert.equal(parseScore('no numbers here'), null);
  assert.deepEqual(parseScore('0/0'), { score: 0, fraction: null });
});

test('logs go to the project setting, then the environment, then .collab', () => {
  const shared = { MODEL_COLLAB_TENSORBOARD_DIR: '/runs/tb' };
  assert.equal(tensorboardDir('/p', { tensorboardDir: 'logs' }, shared), '/p/logs');
  assert.equal(tensorboardDir('/p', {}, shared), '/runs/tb');
  assert.equal(tensorboardDir('/p', {}, {}), '/p/.collab/tensorboard');
});

test('run folders sort by start and name the size and goal', () => {
  assert.equal(
    runLabel({
      id: 'abcdef12-0000',
      createdAt: '2026-10-31T01:02:03.456Z',
      goal: 'Build the Parser: tokens & AST!',
      agents: [{}, {}, {}],
    }),
    '2026-10-31T01-02-03_3agents_build-the-parser-tokens-ast',
  );
});
