import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const git = (cwd, ...args) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, stdio: 'pipe' },
  );

/** A temporary Git project with one commit, removed after the test. */
export async function gitProject(
  t,
  prefix = 'model-collab-',
  files = { 'README.md': 'Project\n' },
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await initGit(root, files);
  return root;
}

/** Turn an existing directory into a Git project with one commit. */
export async function initGit(root, files = { 'README.md': 'Project\n' }) {
  await writeFiles(root, files);
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
}

export async function writeFiles(root, files) {
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), content);
  }
}
