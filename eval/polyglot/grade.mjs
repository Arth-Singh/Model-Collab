#!/usr/bin/env node
// Hidden-test grader. API: grade(taskDir, workspaceDir, opts?) -> {passed, testsPassed, testsTotal, outcome, stdoutTail, ...}
// CLI: node grade.mjs <taskDir|taskId> <workspaceDir> [--keep]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CARGO_TARGET_ROOT,
  RUNS_DIR,
  copyDir,
  copyFile,
  loadTask,
  parseArgs,
  run,
  tail,
  taskDirFor,
} from './common.mjs';

export const GRADE_TIMEOUT_MS = 120_000;
const GRADE_TMP_ROOT = path.join(RUNS_DIR, '.grade');

// Build/cache artifacts are never copied from the agent workspace, so nothing stale can reach the grader.
const COPY_EXCLUDE = new Set([
  '.git',
  '.collab',
  '.gocache',
  '.cache',
  '.claude',
  'target',
  '__pycache__',
  '.pytest_cache',
  'node_modules',
  '.venv',
  'venv',
]);

function baseEnv() {
  return {
    ...process.env,
    CARGO_NET_OFFLINE: 'true',
    CARGO_TERM_COLOR: 'never',
    RUST_BACKTRACE: '0',
    GOFLAGS: '-mod=mod',
    GOPROXY: 'off',
    GOTOOLCHAIN: 'local',
    GOWORK: 'off',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONHASHSEED: '0',
    NO_COLOR: '1',
  };
}

function removeMatching(dir, predicate) {
  const removed = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (predicate(childRel, entry)) {
        fs.rmSync(path.join(dir, childRel), { recursive: true, force: true });
        removed.push(childRel);
      } else if (entry.isDirectory()) {
        walk(childRel);
      }
    }
  };
  walk('');
  return removed;
}

const AGENT_TEST_FILTERS = {
  python: (rel, entry) =>
    entry.isDirectory()
      ? entry.name === 'tests'
      : /_test\.py$/.test(entry.name) ||
        /^test_.*\.py$/.test(entry.name) ||
        entry.name === 'conftest.py',
  go: (rel, entry) => !entry.isDirectory() && entry.name.endsWith('_test.go'),
  rust: (rel, entry) => (entry.isDirectory() ? rel === 'tests' : rel === 'Cargo.lock'),
};

function parsePython(output) {
  const summary =
    output
      .split('\n')
      .filter((line) =>
        /(\d+ (passed|failed|errors?|skipped)|no tests ran)\b.* in \d+(\.\d+)?s\b/.test(line),
      )
      .at(-1) ?? '';
  const count = (word) => Number(summary.match(new RegExp(`(\\d+) ${word}\\b`))?.[1] ?? 0);
  const passed = count('passed');
  const failed = count('failed');
  const errors = count('errors?');
  const collectionError = /ERROR collecting|Interrupted: \d+ error/.test(output);
  return { testsPassed: passed, testsTotal: collectionError ? 0 : passed + failed + errors };
}

function parseGo(stdout) {
  const results = new Map();
  const lines = [];
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) {
      if (line.trim()) lines.push(line);
      continue;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      lines.push(line);
      continue;
    }
    if (typeof event.Output === 'string') lines.push(event.Output.replace(/\n$/, ''));
    if (event.Test && ['pass', 'fail', 'skip'].includes(event.Action))
      results.set(`${event.Package}\u0000${event.Test}`, event.Action);
  }
  const names = [...results.keys()];
  const leaves = names.filter((name) => !names.some((other) => other.startsWith(`${name}/`)));
  return {
    testsPassed: leaves.filter((name) => results.get(name) === 'pass').length,
    testsTotal: leaves.filter((name) => results.get(name) !== 'skip').length,
    text: lines.join('\n'),
  };
}

function parseRust(output) {
  let total = 0;
  let passed = 0;
  for (const match of output.matchAll(/^running (\d+) tests?$/gm)) total += Number(match[1]);
  for (const match of output.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed/gm))
    passed += Number(match[1]);
  return { testsPassed: passed, testsTotal: total };
}

async function withDirLock(lockDir, fn, timeoutMs = 30 * 60_000) {
  const started = Date.now();
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, 'pid'), String(process.pid));
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner = NaN;
      try {
        owner = Number(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8'));
      } catch {}
      let alive = false;
      if (Number.isInteger(owner) && owner > 0) {
        try {
          process.kill(owner, 0);
          alive = true;
        } catch {}
      }
      const ageMs =
        Date.now() - (fs.statSync(lockDir, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (!alive && (Number.isInteger(owner) || ageMs > 10_000)) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started > timeoutMs)
        throw new Error(`Timed out waiting for lock ${lockDir}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function rustPackageName(ws) {
  const manifest = fs.readFileSync(path.join(ws, 'Cargo.toml'), 'utf8');
  const packageSection = manifest.split(/^\[/m).find((section) => section.startsWith('package]'));
  return packageSection?.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ?? null;
}

async function runTests(task, ws, timeoutMs) {
  const env = baseEnv();
  if (task.lang === 'python') {
    const emptyIni = path.join(path.dirname(ws), 'pytest.ini');
    fs.writeFileSync(emptyIni, '[pytest]\n');
    const testFiles = task.testFiles.filter((f) => /_test\.py$/.test(f));
    const result = await run(
      'python3',
      [
        '-m',
        'pytest',
        '-q',
        '-p',
        'no:cacheprovider',
        '-c',
        emptyIni,
        '--rootdir',
        ws,
        ...testFiles,
      ],
      { cwd: ws, env, timeoutMs },
    );
    const text = `${result.stdout}\n${result.stderr}`;
    return { result, text, ...parsePython(text) };
  }
  if (task.lang === 'go') {
    const result = await run('go', ['test', '-json', '-count=1', './...'], {
      cwd: ws,
      env,
      timeoutMs,
    });
    const parsed = parseGo(result.stdout);
    return {
      result,
      text: `${parsed.text}\n${result.stderr}`,
      testsPassed: parsed.testsPassed,
      testsTotal: parsed.testsTotal,
    };
  }
  if (task.lang === 'rust') {
    const targetDir = path.join(CARGO_TARGET_ROOT, task.id);
    return withDirLock(`${targetDir}.lock`, async () => {
      const rustEnv = { ...env, CARGO_TARGET_DIR: targetDir };
      const started = Date.now();
      // Purge this package's own artifacts (keeps compiled dependencies) so stale builds cannot mask a failure.
      const pkg = rustPackageName(ws);
      const clean = pkg
        ? await run('cargo', ['clean', '--offline', '-p', pkg], {
            cwd: ws,
            env: rustEnv,
            timeoutMs: 60_000,
          })
        : { code: 1 };
      if (clean.code !== 0) fs.rmSync(targetDir, { recursive: true, force: true });
      const remaining = Math.max(5_000, timeoutMs - (Date.now() - started));
      const args = [
        'test',
        '--offline',
        ...task.testTargets.flatMap((t) => ['--test', t]),
        '--',
        '--include-ignored',
      ];
      const result = await run('cargo', args, { cwd: ws, env: rustEnv, timeoutMs: remaining });
      const text = `${result.stderr}\n${result.stdout}`;
      return { result, text, ...parseRust(result.stdout) };
    });
  }
  throw new Error(`Unsupported language ${task.lang}`);
}

export async function grade(
  taskDir,
  workspaceDir,
  { timeoutMs = GRADE_TIMEOUT_MS, keep = false } = {},
) {
  const task = loadTask(taskDir);
  if (!fs.existsSync(workspaceDir)) throw new Error(`Workspace not found: ${workspaceDir}`);
  fs.mkdirSync(GRADE_TMP_ROOT, { recursive: true });
  const gradeDir = fs.mkdtempSync(path.join(GRADE_TMP_ROOT, `${task.id}-`));
  const ws = path.join(gradeDir, 'ws');
  try {
    copyDir(workspaceDir, ws, {
      exclude: (rel) => rel.split('/').some((part) => COPY_EXCLUDE.has(part)),
    });
    const removedAgentTests = removeMatching(ws, AGENT_TEST_FILTERS[task.lang]);
    for (const rel of task.supportFiles)
      copyFile(path.join(taskDir, 'support', rel), path.join(ws, rel));
    for (const rel of task.testFiles)
      copyFile(path.join(taskDir, 'hidden', rel), path.join(ws, rel));

    const { result, text, testsPassed, testsTotal } = await runTests(task, ws, timeoutMs);
    const passed =
      !result.timedOut && result.code === 0 && testsTotal > 0 && testsPassed === testsTotal;
    let outcome;
    if (result.timedOut) outcome = 'timeout';
    else if (passed) outcome = 'pass';
    else if (testsTotal === 0) outcome = 'compile_error';
    else outcome = 'fail';
    return {
      taskId: task.id,
      passed,
      testsPassed,
      testsTotal,
      outcome,
      exitCode: result.code,
      durationMs: result.durationMs,
      removedAgentTests,
      stdoutTail: tail(text),
      ...(keep ? { gradeDir } : {}),
    };
  } finally {
    if (!keep) fs.rmSync(gradeDir, { recursive: true, force: true });
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const [taskArg, workspaceArg] = opts._;
  if (!taskArg || !workspaceArg) {
    console.error(
      'usage: node grade.mjs <taskDir|taskId> <workspaceDir> [--keep] [--timeout-ms N]',
    );
    process.exit(2);
  }
  const taskDir = fs.existsSync(path.join(taskArg, 'task.json'))
    ? path.resolve(taskArg)
    : taskDirFor(taskArg);
  const result = await grade(taskDir, path.resolve(workspaceArg), {
    keep: Boolean(opts.keep),
    timeoutMs: opts['timeout-ms'] ? Number(opts['timeout-ms']) : GRADE_TIMEOUT_MS,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.passed ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack ?? String(error));
    process.exit(2);
  });
}
