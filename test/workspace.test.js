import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  applyChanges,
  captureBase,
  checkoutCommit,
  cloneForAgent,
  commitChanges,
  createOrigin,
  originHead,
  originLog,
} from '../src/workspace.js';
import { gitProject, writeFiles } from './helpers.js';

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

async function swarmRepo(t, files) {
  const root = await gitProject(t, 'model-collab-origin-', {
    '.gitignore': '.collab/\nnode_modules/\n',
    'README.md': 'Project\n',
    'src/old.js': 'old\n',
    ...files,
  });
  const dir = path.join(root, '.collab', 'run');
  const base = await captureBase(root, path.join(root, '.collab', 'tmp'), ['node_modules']);
  const origin = await createOrigin(base, path.join(dir, 'origin.git'));
  const clone = (name) =>
    cloneForAgent(base, origin, {
      workspace: path.join(dir, 'work', name),
      gitDir: path.join(dir, 'git', name),
      name,
    });
  return { root, dir, base, origin, clone };
}

test('the origin starts at the base snapshot and borrows its objects', async (t) => {
  const { root, base, origin } = await swarmRepo(t);
  await writeFiles(root, { 'later.txt': 'not in the snapshot\n' });
  assert.equal(await originHead(origin), base.commit);
  const alternates = await fs.readFile(path.join(origin, 'objects', 'info', 'alternates'), 'utf8');
  assert.equal(alternates.trim(), path.join(root, '.git', 'objects'));
  assert.deepEqual(await originLog(origin, base.commit), []);
});

test('agents commit as themselves, rebase on each other, and push to main', async (t) => {
  const { base, origin, clone } = await swarmRepo(t);
  const a = await clone('claude-1');
  const b = await clone('codex-1');
  assert.match(await fs.readFile(path.join(a, '.git'), 'utf8'), /^gitdir: .*git\/claude-1/);

  await writeFiles(a, { 'src/lexer.js': 'lexer\n' });
  git(a, 'add', '-A');
  git(a, 'commit', '-q', '-m', 'Add lexer');
  git(a, 'push', '-q', 'origin', 'HEAD:main');

  await writeFiles(b, { 'src/cli.js': 'cli\n' });
  git(b, 'add', '-A');
  git(b, 'commit', '-q', '-m', 'Add CLI');
  assert.throws(() => git(b, 'push', '-q', 'origin', 'HEAD:main'), /rejected|fetch first/);
  git(b, 'pull', '-q');
  git(b, 'push', '-q', 'origin', 'HEAD:main');

  const log = await originLog(origin, base.commit);
  assert.deepEqual(
    log.map((c) => [c.author, c.subject]),
    [
      ['claude-1', 'Add lexer'],
      ['codex-1', 'Add CLI'],
    ],
  );
  assert.equal(await originHead(origin), log[1].commit);
  assert.throws(
    () => git(a, 'push', '-q', '--force', 'origin', `${base.commit}:main`),
    /denied|rejected/,
    'history only moves forward',
  );
});

test('linked dependency folders are shared but never committed', async (t) => {
  const { base, clone } = await swarmRepo(t, { 'node_modules/dep/index.js': 'dep\n' });
  assert.deepEqual(base.links, ['node_modules']);
  const work = await clone('claude-2');
  assert.equal(
    await fs.readFile(path.join(work, 'node_modules', 'dep', 'index.js'), 'utf8'),
    'dep\n',
  );
  await writeFiles(work, {
    '.gocache/x': 'cache\n',
    'kit/__pycache__/a.cpython-312.pyc': 'bytecode',
    '.pytest_cache/v/cache': '{}',
  });
  git(work, 'add', '-A');
  assert.equal(git(work, 'status', '--porcelain'), '');
});

test("the result's changes apply to the user's tree, including deletions and modes", async (t) => {
  const { root, dir, base, origin, clone } = await swarmRepo(t, { 'src/gone.js': 'gone\n' });
  const a = await clone('claude-1');
  await writeFiles(a, { 'src/old.js': 'new\n', 'bin/run.sh': '#!/bin/sh\necho hi\n' });
  await fs.chmod(path.join(a, 'bin', 'run.sh'), 0o755);
  await fs.rm(path.join(a, 'src', 'gone.js'));
  await fs.symlink('old.js', path.join(a, 'src', 'alias.js'));
  git(a, 'add', '-A');
  git(a, 'commit', '-q', '-m', 'Rework');
  git(a, 'push', '-q', 'origin', 'HEAD:main');

  const head = await originHead(origin);
  const filesDir = path.join(dir, 'result', 'files');
  const changes = await commitChanges(origin, base, head, filesDir);
  assert.deepEqual(
    changes.map((c) => [c.path, c.status]),
    [
      ['bin/run.sh', 'added'],
      ['src/alias.js', 'added'],
      ['src/gone.js', 'deleted'],
      ['src/old.js', 'modified'],
    ],
  );
  assert.equal(changes[0].executable, true);
  assert.equal(changes[1].symlink, 'old.js');

  const applied = await applyChanges(base, changes, filesDir);
  assert.deepEqual(applied, ['bin/run.sh', 'src/alias.js', 'src/gone.js', 'src/old.js']);
  assert.equal(await fs.readFile(path.join(root, 'src', 'old.js'), 'utf8'), 'new\n');
  assert.equal(await fs.readlink(path.join(root, 'src', 'alias.js')), 'old.js');
  assert.ok((await fs.stat(path.join(root, 'bin', 'run.sh'))).mode & 0o100);
  await assert.rejects(fs.access(path.join(root, 'src', 'gone.js')));

  const checkout = await checkoutCommit(origin, base, head, path.join(dir, 'check'));
  assert.equal(await fs.readFile(path.join(checkout, 'src', 'old.js'), 'utf8'), 'new\n');
  await assert.rejects(fs.access(path.join(checkout, 'src', 'gone.js')));
});
