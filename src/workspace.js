import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

// Each peer works in its own Git worktree created from a snapshot of the user's
// project. Proposals copy the files a peer changed; checks and reviews run in
// fresh checkouts of a candidate; the agreed candidate is applied to the user's
// tree only if the files it touches have not changed since the snapshot.

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Model Collab',
  GIT_AUTHOR_EMAIL: 'model-collab@localhost',
  GIT_COMMITTER_NAME: 'Model Collab',
  GIT_COMMITTER_EMAIL: 'model-collab@localhost',
};
const BASE_REF = 'refs/model-collab/base';
const MAX_CHANGED_FILES = 500;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

// New files under these names are build or tool output, even in projects whose
// .gitignore does not say so. Changes to tracked files are always captured.
const ARTIFACT_DIRS = new Set([
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.venv',
  'node_modules',
  '.gocache',
]);
const ARTIFACT_FILES = /(^|\/)\.DS_Store$|\.py[co]$/;
const isArtifact = (file) =>
  ARTIFACT_FILES.test(file) ||
  file
    .split('/')
    .slice(0, -1)
    .some((part) => ARTIFACT_DIRS.has(part));

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const fail = (message) => {
  throw new Error(message);
};

function run(command, args, { cwd, env, stdin, stdout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...env },
      stdio: [stdin ? 'pipe' : 'ignore', stdout ? 'pipe' : 'pipe', 'pipe'],
    });
    const chunks = [];
    let stderr = '';
    if (stdin) stdin.pipe(child.stdin);
    if (stdout) child.stdout.pipe(stdout);
    else child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(chunks), stderr }));
  });
}

export async function git(cwd, args, { env, allowFailure = false } = {}) {
  const result = await run('git', ['-c', 'core.quotepath=off', ...args], { cwd, env });
  if (result.code !== 0 && !allowFailure)
    fail(`git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  return result;
}

const text = (result) => result.stdout.toString('utf8').trim();
const nulList = (buffer) => buffer.toString('utf8').split('\0').filter(Boolean);

export async function repoInfo(root) {
  const real = await fs.realpath(root);
  const top = await git(real, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (top.code !== 0)
    fail(
      'Model Collab needs a Git repository so each agent can work in its own worktree. Run `git init` in the project first.',
    );
  const prefix = text(await git(real, ['rev-parse', '--show-prefix']));
  return { top: await fs.realpath(text(top)), prefix };
}

/**
 * Commit the current working tree, tracked and untracked, without touching the
 * user's index. `dependencyDirs` names ignored directories (such as node_modules)
 * that worktrees and checkouts link to instead of rebuilding.
 */
export async function captureBase(root, tmpDir, dependencyDirs = []) {
  const { top, prefix } = await repoInfo(root);
  await fs.mkdir(tmpDir, { recursive: true });
  const index = path.join(tmpDir, `base-${randomUUID()}.index`);
  const env = { GIT_INDEX_FILE: index, ...IDENTITY };
  try {
    const head = await git(top, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], {
      allowFailure: true,
    });
    const parent = head.code === 0 ? text(head) : null;
    await git(top, parent ? ['read-tree', parent] : ['read-tree', '--empty'], { env });
    // .collab is normally ignored. Naming an ignored path in a pathspec is an
    // error, so exclude it explicitly only when the project does not ignore it.
    const ignored = await git(top, ['check-ignore', '-q', `${prefix}.collab/`], {
      allowFailure: true,
    });
    await git(
      top,
      ['add', '-A', ...(ignored.code === 0 ? [] : ['--', '.', `:(top,exclude)${prefix}.collab`])],
      { env },
    );
    const tree = text(await git(top, ['write-tree'], { env }));
    const commit = text(
      await git(
        top,
        ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'Model Collab base'],
        { env },
      ),
    );
    // Keep the snapshot reachable so garbage collection cannot remove it mid-session.
    await git(top, ['update-ref', BASE_REF, commit]);
    return { commit, top, prefix, links: await dependencyLinks(top, dependencyDirs) };
  } finally {
    await fs.rm(index, { force: true });
  }
}

/**
 * Ignored directories whose name is listed in `dependencyDirs`, at any depth.
 * Only these are shared: agents' sandboxes cannot write through the links, so a
 * shared build or cache directory would break builds rather than speed them up.
 */
async function dependencyLinks(top, dependencyDirs) {
  if (!dependencyDirs.length) return [];
  const names = new Set(dependencyDirs);
  const ignored = nulList(
    (
      await git(top, [
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--directory',
        '--no-empty-directory',
        '-z',
      ])
    ).stdout,
  );
  return ignored
    .filter((entry) => entry.endsWith('/'))
    .map((entry) => entry.slice(0, -1))
    .filter((entry) => names.has(path.posix.basename(entry)))
    .filter((entry) => !entry.split('/').some((part) => part === '.git' || part === '.collab'))
    .slice(0, 500);
}

async function linkDependencies(base, dir) {
  for (const entry of base.links) {
    const link = path.join(dir, entry);
    const exists = await fs.lstat(link).then(
      () => true,
      () => false,
    );
    if (exists) continue;
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(path.join(base.top, entry), link);
  }
}

export async function createWorkspace(base, dir) {
  await removeWorkspace(base.top, dir);
  await fs.mkdir(path.dirname(dir), { recursive: true });
  await git(base.top, ['worktree', 'add', '--detach', '--force', dir, base.commit]);
  await linkDependencies(base, dir);
  return path.join(dir, base.prefix);
}

export async function removeWorkspace(top, dir) {
  const exists = await fs.lstat(dir).then(
    () => true,
    () => false,
  );
  if (!exists) return;
  await git(top, ['worktree', 'remove', '--force', '--force', dir], { allowFailure: true });
  await fs.rm(dir, { recursive: true, force: true });
  await git(top, ['worktree', 'prune'], { allowFailure: true });
}

function safeRelative(file) {
  const normalized = path.posix.normalize(file);
  if (
    path.posix.isAbsolute(normalized) ||
    normalized.startsWith('../') ||
    normalized === '..' ||
    normalized.split('/').includes('.git')
  )
    fail(`Unsafe path in candidate: ${file}`);
  return normalized;
}

/** Copy every file a peer changed relative to the base into `destination`. */
export async function snapshotWorkspace(base, workspaceRoot, destination) {
  const linked = new Set(base.links);
  const isLinked = (file) =>
    [...linked].some((entry) => file === entry || file.startsWith(entry + '/'));
  const diff = nulList(
    (await git(workspaceRoot, ['diff', '--name-status', '--no-renames', '-z', base.commit, '--']))
      .stdout,
  );
  const status = new Map();
  for (let i = 0; i + 1 < diff.length; i += 2) status.set(diff[i + 1], diff[i][0]);
  const untracked = nulList(
    (await git(workspaceRoot, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout,
  );
  for (const file of untracked) if (!isArtifact(file)) status.set(file, 'A');
  const changes = [];
  let total = 0;
  for (const [file, code] of [...status].sort(([a], [b]) => a.localeCompare(b))) {
    const relative = safeRelative(file);
    if (isLinked(relative) || relative.split('/')[0] === '.collab') continue;
    if (changes.length >= MAX_CHANGED_FILES)
      fail(`A candidate may change at most ${MAX_CHANGED_FILES} files.`);
    const source = path.join(workspaceRoot, relative);
    if (code === 'D') {
      changes.push({ path: relative, status: 'deleted' });
      continue;
    }
    const info = await fs.lstat(source).catch(() => null);
    if (!info) {
      changes.push({ path: relative, status: 'deleted' });
      continue;
    }
    if (info.isSymbolicLink()) {
      const target = await fs.readlink(source);
      changes.push({
        path: relative,
        status: code === 'A' ? 'added' : 'modified',
        symlink: target,
        sha256: sha256(Buffer.from(target)),
      });
      continue;
    }
    if (!info.isFile()) continue;
    if (info.size > MAX_FILE_BYTES) fail(`Changed file is larger than 10 MiB: ${relative}`);
    total += info.size;
    if (total > MAX_TOTAL_BYTES) fail('A candidate may change at most 50 MiB of files.');
    const content = await fs.readFile(source);
    const target = path.join(destination, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, { mode: info.mode & 0o777 });
    changes.push({
      path: relative,
      status: code === 'A' ? 'added' : 'modified',
      executable: Boolean(info.mode & 0o111),
      sha256: sha256(content),
    });
  }
  return changes;
}

async function writeChange(filesDir, change, target) {
  await fs.rm(target, { force: true });
  if (change.status === 'deleted') return;
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (change.symlink !== undefined) {
    await fs.symlink(change.symlink, target);
    return;
  }
  await fs.copyFile(path.join(filesDir, change.path), target);
  await fs.chmod(target, change.executable ? 0o755 : 0o644);
}

/** A fresh, Git-free copy of the base with the candidate's changes and dependency links. */
export async function materialize(base, candidate, filesDir, dir) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const archive = spawn('git', ['archive', '--format=tar', base.commit], {
    cwd: base.top,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let archiveError = '';
  archive.stderr.on('data', (chunk) => (archiveError += chunk));
  const extracted = await run('tar', ['-x', '-f', '-', '-C', dir], { stdin: archive.stdout });
  if (extracted.code !== 0)
    fail(`Could not create a checkout: ${archiveError.trim() || extracted.stderr.trim()}`);
  for (const change of candidate.changes)
    await writeChange(filesDir, change, path.join(dir, safeRelative(change.path)));
  await linkDependencies(base, dir);
  return path.join(dir, base.prefix);
}

// A path's state for conflict detection: null (absent), a file with its content
// and executable bit, a symlink target, or something else (such as a directory).
const sameEntry = (a, b) =>
  a === null || b === null
    ? a === b
    : a.type === b.type &&
      (a.type !== 'file' || (a.content.equals(b.content) && a.executable === b.executable)) &&
      (a.type !== 'symlink' || a.target === b.target);

async function baseEntry(base, file) {
  const listed = await git(base.top, ['ls-tree', '-z', base.commit, '--', file], {
    env: { GIT_LITERAL_PATHSPECS: '1' },
  });
  const line = nulList(listed.stdout)[0];
  if (!line) return null;
  const [mode, type, object] = line.slice(0, line.indexOf('\t')).split(' ');
  if (type !== 'blob') return { type: 'other' };
  const content = (await git(base.top, ['cat-file', 'blob', object])).stdout;
  if (mode === '120000') return { type: 'symlink', target: content.toString('utf8') };
  return { type: 'file', content, executable: mode === '100755' };
}

async function baseContent(base, file) {
  const entry = await baseEntry(base, file);
  return entry?.type === 'file'
    ? entry.content
    : entry?.type === 'symlink'
      ? Buffer.from(entry.target)
      : null;
}

async function currentEntry(file) {
  const info = await fs.lstat(file).catch(() => null);
  if (!info) return null;
  if (info.isSymbolicLink()) return { type: 'symlink', target: await fs.readlink(file) };
  if (!info.isFile()) return { type: 'other' };
  return { type: 'file', content: await fs.readFile(file), executable: Boolean(info.mode & 0o111) };
}

async function wantedEntry(filesDir, change) {
  if (change.status === 'deleted') return null;
  if (change.symlink !== undefined) return { type: 'symlink', target: change.symlink };
  return {
    type: 'file',
    content: await fs.readFile(path.join(filesDir, change.path)),
    executable: Boolean(change.executable),
  };
}

async function restoreEntry(target, entry) {
  await fs.rm(target, { force: true });
  if (entry === null) return;
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (entry.type === 'symlink') await fs.symlink(entry.target, target);
  else if (entry.type === 'file') {
    await fs.writeFile(target, entry.content);
    await fs.chmod(target, entry.executable ? 0o755 : 0o644);
  }
}

/**
 * Apply a candidate to the user's working tree, all or nothing. Every path and
 * every parent directory is checked first; if any changed since the base in a
 * different way, nothing is written. If writing fails midway, the files already
 * written are restored.
 */
export async function applyCandidate(base, candidate, filesDir) {
  const plan = [];
  const conflicts = [];
  const deleting = new Set(
    candidate.changes.filter((c) => c.status === 'deleted').map((c) => safeRelative(c.path)),
  );
  for (const change of candidate.changes) {
    const relative = safeRelative(change.path);
    const target = path.join(base.top, relative);
    const parts = relative.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      const info = await fs.lstat(path.join(base.top, parent)).catch(() => null);
      if (!info) break;
      if (info.isDirectory()) continue;
      // A parent may be a plain file only if this candidate deletes it unchanged.
      const unchanged = sameEntry(
        await currentEntry(path.join(base.top, parent)),
        await baseEntry(base, parent),
      );
      if (!deleting.has(parent) || !unchanged) conflicts.push(parent);
      break;
    }
    const current = await currentEntry(target);
    const wanted = await wantedEntry(filesDir, change);
    if (sameEntry(current, wanted)) continue;
    if (!sameEntry(current, await baseEntry(base, relative))) conflicts.push(relative);
    else plan.push({ change, target, current });
  }
  if (conflicts.length)
    fail(
      `Not applied: you changed ${[...new Set(conflicts)].join(', ')} after the session started. Resolve and run model-collab apply.`,
    );
  // Deletions first, so a file can be replaced by a directory of the same name.
  plan.sort((a, b) => (b.change.status === 'deleted') - (a.change.status === 'deleted'));
  const written = [];
  const createdDirs = [];
  try {
    for (const item of plan) {
      let missing = path.dirname(item.target);
      const chain = [];
      while (missing !== base.top && !(await fs.lstat(missing).catch(() => null))) {
        chain.push(missing);
        missing = path.dirname(missing);
      }
      written.push(item);
      await writeChange(filesDir, item.change, item.target);
      createdDirs.push(...chain);
    }
  } catch (error) {
    for (const { target, current } of written.reverse())
      await restoreEntry(target, current).catch(() => {});
    for (const dir of createdDirs.sort((a, b) => b.length - a.length))
      await fs.rmdir(dir).catch(() => {});
    fail(`Not applied: ${error.message}. Your working tree was left as it was.`);
  }
  return plan.map(({ change }) => change.path).sort();
}

/** Unified diff of a candidate against the base, for review. */
export async function candidateDiff(base, candidate, filesDir, scratch) {
  const before = path.join(scratch, 'a'),
    after = path.join(scratch, 'b');
  await fs.rm(scratch, { recursive: true, force: true });
  await fs.mkdir(before, { recursive: true });
  await fs.mkdir(after, { recursive: true });
  try {
    for (const change of candidate.changes) {
      const relative = safeRelative(change.path);
      const original = await baseContent(base, relative);
      if (original !== null) {
        await fs.mkdir(path.dirname(path.join(before, relative)), { recursive: true });
        await fs.writeFile(path.join(before, relative), original);
      }
      if (change.status !== 'deleted')
        await writeChange(filesDir, change, path.join(after, relative));
    }
    const result = await git(
      scratch,
      ['diff', '--no-index', '--no-color', '--no-prefix', 'a', 'b'],
      {
        allowFailure: true,
      },
    );
    return result.stdout.toString('utf8');
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
