import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { doctor, renderDoctor } from '../src/doctor.js';

test('doctor checks requirements without changing the project or starting model turns', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-collab-doctor-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const result = await doctor({
    root,
    run: async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: `${argv[0]} fixture-version\n`, stderr: '' };
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ['tmux', '-V'],
    ['codex', '--version'],
    ['claude', '--version'],
  ]);
  assert.deepEqual(await fs.readdir(root), []);
  assert.match(renderDoctor(result), /Ready to start/);
  assert.match(renderDoctor(result), /Sign in/);
});

test('doctor reports missing tools and directories with a useful next action', async () => {
  const result = await doctor({
    root: '/no/such/model-collab-project',
    run: async () => ({ code: null, error: 'spawn failed' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.checks.filter((check) => !check.ok).length, 4);
  assert.match(renderDoctor(result), /Install tmux/);
  assert.match(renderDoctor(result), /Directory not found/);
});
