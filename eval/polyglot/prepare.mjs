#!/usr/bin/env node
// Build tasks/<lang>-<slug>/{workspace,hidden,reference,support,task.json} from the polyglot benchmark.
import fs from 'node:fs';
import path from 'node:path';
import {
  BENCHMARK_COMMIT,
  BENCHMARK_REPO,
  BENCH_DIR,
  LANGS,
  ROOT,
  TASKS_DIR,
  copyFile,
  filterIds,
  listFiles,
  parseArgs,
  readJson,
  run,
  writeJson,
} from './common.mjs';

const EXERCISE_METADATA_DIRS = new Set(['.docs', '.meta', '.approaches', '.articles']);

// .cache/ holds per-run toolchain caches (see agent.mjs agentEnv); sandboxed agents cannot write to ~/Library/Caches.
const GITIGNORE = {
  python: '.cache/\n__pycache__/\n*.pyc\n.pytest_cache/\n',
  go: '.cache/\n*.test\n*.out\n',
  rust: '.cache/\ntarget/\nCargo.lock\n**/*.rs.bk\n',
};

const TEST_COMMAND = {
  python: (task) =>
    `python3 -m pytest -q -p no:cacheprovider ${task.testFiles.filter((f) => f.endsWith('_test.py')).join(' ')}`,
  go: () => 'go test -json -count=1 ./...',
  rust: (task) =>
    `cargo test --offline ${task.testTargets.map((t) => `--test ${t}`).join(' ')} -- --include-ignored`,
};

function isTestFile(lang, rel, config) {
  if ((config.files.test ?? []).includes(rel)) return true;
  const base = path.posix.basename(rel);
  if (lang === 'python')
    return /_test\.py$/.test(base) || /^test_.*\.py$/.test(base) || base === 'conftest.py';
  if (lang === 'go') return base.endsWith('_test.go');
  if (lang === 'rust') return rel.startsWith('tests/');
  throw new Error(`Unsupported language ${lang}`);
}

/** Non-solution, non-test source files the hidden tests depend on; restored verbatim before grading. */
function isSupportFile(lang, rel, config) {
  if (config.files.solution.includes(rel)) return false;
  if (lang === 'go') return rel.endsWith('.go');
  if (lang === 'rust') return rel.startsWith('src/') && rel.endsWith('.rs');
  if (lang === 'python') return rel.endsWith('.py');
  return false;
}

function buildInstructions(exDir) {
  const parts = ['introduction.md', 'instructions.md', 'instructions.append.md']
    .map((name) => path.join(exDir, '.docs', name))
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.readFileSync(file, 'utf8').trim());
  if (!parts.some(Boolean)) throw new Error(`${exDir}: no .docs instructions`);
  return `${parts.join('\n\n')}\n`;
}

function referenceMapping(lang, exDir, config) {
  const examples = config.files.example ?? [];
  if (examples.length !== 1)
    throw new Error(`${exDir}: expected exactly one example file, got ${JSON.stringify(examples)}`);
  const example = examples[0];
  const mapping = [];
  if (lang === 'rust') {
    if (!example.endsWith('.rs')) throw new Error(`${exDir}: rust example is not .rs: ${example}`);
    mapping.push({ from: example, to: 'src/lib.rs' });
    if (fs.existsSync(path.join(exDir, '.meta/Cargo-example.toml')))
      mapping.push({ from: '.meta/Cargo-example.toml', to: 'Cargo.toml' });
  } else {
    const ext = lang === 'python' ? '.py' : '.go';
    const targets = config.files.solution.filter((f) => f.endsWith(ext));
    if (targets.length !== 1)
      throw new Error(
        `${exDir}: expected one ${ext} solution file, got ${JSON.stringify(targets)}`,
      );
    mapping.push({ from: example, to: targets[0] });
  }
  for (const { from } of mapping) {
    if (!fs.existsSync(path.join(exDir, from)))
      throw new Error(`${exDir}: missing reference file ${from}`);
  }
  return mapping;
}

async function git(cwd, args) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'eval',
    GIT_AUTHOR_EMAIL: 'eval@localhost',
    GIT_COMMITTER_NAME: 'eval',
    GIT_COMMITTER_EMAIL: 'eval@localhost',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
  const result = await run('git', args, { cwd, env, timeoutMs: 30_000 });
  if (result.code !== 0)
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  return result.stdout.trim();
}

async function prepareExercise(lang, slug) {
  const exDir = path.join(BENCH_DIR, lang, 'exercises/practice', slug);
  const id = `${lang}-${slug}`;
  const config = readJson(path.join(exDir, '.meta/config.json'));
  if (fs.existsSync(path.join(exDir, '.meta/.skip_tests'))) {
    return {
      id,
      skipped:
        '.meta/.skip_tests present: exercise asks the student to write tests, no gradable hidden suite',
    };
  }

  const files = listFiles(exDir, { skip: (rel) => EXERCISE_METADATA_DIRS.has(rel.split('/')[0]) });
  const testFiles = files.filter((rel) => isTestFile(lang, rel, config));
  const workspaceFiles = files.filter((rel) => !testFiles.includes(rel));
  const supportFiles = workspaceFiles.filter((rel) => isSupportFile(lang, rel, config));
  for (const rel of config.files.test) {
    if (!testFiles.includes(rel)) throw new Error(`${id}: configured test file ${rel} not found`);
  }
  for (const rel of config.files.solution) {
    if (!workspaceFiles.includes(rel))
      throw new Error(`${id}: solution file ${rel} missing from stub`);
  }
  if (workspaceFiles.includes('INSTRUCTIONS.md'))
    throw new Error(`${id}: stub already has INSTRUCTIONS.md`);

  const taskDir = path.join(TASKS_DIR, id);
  const ws = path.join(taskDir, 'workspace');
  for (const rel of workspaceFiles) copyFile(path.join(exDir, rel), path.join(ws, rel));
  fs.writeFileSync(path.join(ws, 'INSTRUCTIONS.md'), buildInstructions(exDir));
  fs.writeFileSync(path.join(ws, '.gitignore'), GITIGNORE[lang]);
  for (const rel of testFiles) copyFile(path.join(exDir, rel), path.join(taskDir, 'hidden', rel));
  for (const rel of supportFiles)
    copyFile(path.join(exDir, rel), path.join(taskDir, 'support', rel));
  const reference = referenceMapping(lang, exDir, config);
  for (const { from, to } of reference)
    copyFile(path.join(exDir, from), path.join(taskDir, 'reference', to));

  await git(ws, ['init', '-q', '-b', 'main']);
  await git(ws, ['add', '-A']);
  await git(ws, ['commit', '-q', '-m', `Exercise stub: ${id}`]);

  const task = {
    id,
    lang,
    slug,
    solutionFiles: config.files.solution,
    testFiles,
    supportFiles,
    referenceFiles: reference.map((r) => r.to),
    testTargets:
      lang === 'rust'
        ? testFiles
            .filter((f) => /^tests\/[^/]+\.rs$/.test(f))
            .map((f) => path.posix.basename(f, '.rs'))
        : undefined,
    source: path.relative(BENCH_DIR, exDir),
  };
  task.testCommand = TEST_COMMAND[lang](task);
  writeJson(path.join(taskDir, 'task.json'), task);
  return { id, task };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const fetch = `git clone ${BENCHMARK_REPO} ${BENCH_DIR} && git -C ${BENCH_DIR} checkout ${BENCHMARK_COMMIT}`;
  if (!fs.existsSync(BENCH_DIR)) throw new Error(`No benchmark at ${BENCH_DIR}. Run: ${fetch}`);
  const commit = (await run('git', ['rev-parse', 'HEAD'], { cwd: BENCH_DIR })).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(commit))
    throw new Error(`Cannot read benchmark commit at ${BENCH_DIR}`);
  if (commit !== BENCHMARK_COMMIT)
    throw new Error(
      `The benchmark at ${BENCH_DIR} is at ${commit}, not ${BENCHMARK_COMMIT}. Run: git -C ${BENCH_DIR} checkout ${BENCHMARK_COMMIT}`,
    );
  const dirty = (await run('git', ['status', '--porcelain'], { cwd: BENCH_DIR })).stdout.trim();

  const all = LANGS.flatMap((lang) =>
    fs
      .readdirSync(path.join(BENCH_DIR, lang, 'exercises/practice'))
      .filter((slug) =>
        fs.existsSync(path.join(BENCH_DIR, lang, 'exercises/practice', slug, '.meta/config.json')),
      )
      .sort()
      .map((slug) => `${lang}-${slug}`),
  );
  const ids = filterIds(all, opts);

  fs.rmSync(TASKS_DIR, { recursive: true, force: true });
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  const prepared = [];
  const skipped = [];
  for (const id of ids) {
    const lang = LANGS.find((l) => id.startsWith(`${l}-`));
    const result = await prepareExercise(lang, id.slice(lang.length + 1));
    if (result.skipped) skipped.push({ id, reason: result.skipped });
    else prepared.push(id);
  }

  const counts = Object.fromEntries(
    LANGS.map((l) => [l, prepared.filter((id) => id.startsWith(`${l}-`)).length]),
  );
  writeJson(path.join(ROOT, 'manifest.json'), {
    benchmark: { repo: BENCHMARK_REPO, path: BENCH_DIR, commit, dirty: Boolean(dirty) },
    generatedAt: new Date().toISOString(),
    languages: LANGS,
    counts,
    total: prepared.length,
    skipped,
    tasks: prepared,
  });
  console.log(JSON.stringify({ commit, counts, total: prepared.length, skipped }, null, 2));
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exit(1);
});
