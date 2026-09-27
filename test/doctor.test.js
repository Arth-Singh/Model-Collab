import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { doctor, renderDoctor } from '../src/doctor.js';

const HELP = {
  'codex exec --help': 'Options:\n  --ignore-rules\n  --output-schema <FILE>\n',
  'claude --help': 'Options:\n  --permission-prompts\n  --safe-mode\n  --json-schema <schema>\n',
};

function fakeTools(overrides = {}) {
  const calls = [];
  const run = async (argv) => {
    calls.push(argv);
    const key = argv.join(' ');
    if (key in overrides) return overrides[key];
    if (key in HELP) return { code: 0, stdout: HELP[key], stderr: '' };
    if (argv[0] === 'git' && argv.includes('rev-parse'))
      return { code: 0, stdout: `${argv[2]}\n`, stderr: '' };
    return { code: 0, stdout: `${argv[0]} fixture-version\n`, stderr: '' };
  };
  return { calls, run };
}

test('doctor checks requirements without changing the project or starting model turns', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-collab-doctor-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { calls, run } = fakeTools();
  const result = await doctor({ root, run });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((argv) => argv.join(' ')).sort(), [
    'claude --help',
    'claude --version',
    'codex --version',
    'codex exec --help',
    'git --version',
    `git -C ${await fs.realpath(root)} rev-parse --show-toplevel`,
    'tmux -V',
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
  assert.equal(result.checks.filter((check) => !check.ok).length, 5);
  assert.match(renderDoctor(result), /Install Git/);
  assert.match(renderDoctor(result), /Install tmux/);
  assert.match(renderDoctor(result), /Directory not found/);
});

test('doctor names worker flags an outdated CLI lacks and a folder outside Git', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-collab-doctor-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { run } = fakeTools({
    'codex exec --help': { code: 0, stdout: 'Options:\n  --output-schema <FILE>\n', stderr: '' },
    [`git -C ${await fs.realpath(root)} rev-parse --show-toplevel`]: {
      code: 128,
      stdout: '',
      stderr: 'fatal: not a git repository',
    },
  });
  const result = await doctor({ root, run });
  assert.equal(result.ok, false);
  const failed = Object.fromEntries(
    result.checks.filter((check) => !check.ok).map((check) => [check.name, check.detail]),
  );
  assert.deepEqual(Object.keys(failed).sort(), ['Git repository', 'codex']);
  assert.match(failed.codex, /lacks --ignore-rules; update codex/);
  assert.match(failed['Git repository'], /git init/);
});
