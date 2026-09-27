import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const BENCHMARK_REPO = 'https://github.com/Aider-AI/polyglot-benchmark';
// The task sets were selected at this commit.
export const BENCHMARK_COMMIT = '7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f';
export const BENCH_DIR =
  process.env.POLYGLOT_BENCH_DIR ?? path.join(ROOT, '.cache', 'polyglot-benchmark');
export const TASKS_DIR = path.join(ROOT, 'tasks');
export const RUNS_DIR = path.join(ROOT, 'runs');
export const CARGO_TARGET_ROOT = path.join(ROOT, '.cargo-target');
export const LANGS = ['python', 'go', 'rust'];

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function listFiles(dir, { skip = () => false } = {}) {
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (skip(childRel, entry)) continue;
      if (entry.isDirectory()) walk(childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  };
  walk('');
  return out.sort();
}

export function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

export function copyDir(src, dest, { exclude = () => false } = {}) {
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (source) => {
      const rel = path.relative(src, source);
      return rel === '' || !exclude(rel.split(path.sep).join('/'));
    },
  });
}

export function loadTask(taskDir) {
  return readJson(path.join(taskDir, 'task.json'));
}

export function taskDirFor(id) {
  return path.join(TASKS_DIR, id);
}

export function listTaskIds() {
  if (!fs.existsSync(TASKS_DIR))
    throw new Error(`No tasks at ${TASKS_DIR}; run prepare.mjs first.`);
  return fs
    .readdirSync(TASKS_DIR)
    .filter((name) => fs.existsSync(path.join(TASKS_DIR, name, 'task.json')))
    .sort();
}

export function langOf(id) {
  const lang = LANGS.find((l) => id.startsWith(`${l}-`));
  if (!lang) throw new Error(`Cannot infer language from task id ${id}`);
  return lang;
}

/**
 * Run a command without a shell. Kills the whole process group on timeout.
 * Resolves (never rejects) with exit status, output, and timing.
 */
export function run(
  cmd,
  args,
  { cwd, env = process.env, input, timeoutMs = 120_000, maxBytes = 64 * 1024 * 1024 } = {},
) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({
        code: null,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: String(error),
        durationMs: 0,
        spawnError: String(error),
      });
      return;
    }
    const chunks = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    for (const stream of ['stdout', 'stderr']) {
      child[stream].on('data', (buf) => {
        if (sizes[stream] < maxBytes) chunks[stream].push(buf);
        sizes[stream] += buf.length;
      });
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    let spawnError = null;
    child.on('error', (error) => {
      spawnError = String(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        timedOut,
        stdout: Buffer.concat(chunks.stdout).toString('utf8'),
        stderr: Buffer.concat(chunks.stderr).toString('utf8'),
        durationMs: Date.now() - started,
        spawnError,
      });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      opts._.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split('=', 2);
    if (inline !== undefined) opts[key] = inline;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts[key] = argv[++i];
    else opts[key] = true;
  }
  return opts;
}

/** --only a,b,c  or  --per-lang N (first N ids per language, sorted). */
export function filterIds(ids, opts) {
  if (opts.only) {
    const wanted = String(opts.only).split(',').filter(Boolean);
    const missing = wanted.filter((id) => !ids.includes(id));
    if (missing.length) throw new Error(`Unknown task ids: ${missing.join(', ')}`);
    return wanted;
  }
  if (opts['per-lang']) {
    const n = Number(opts['per-lang']);
    return LANGS.flatMap((lang) => ids.filter((id) => langOf(id) === lang).slice(0, n));
  }
  return ids;
}

export function tail(text, chars = 4000) {
  return text.length > chars ? text.slice(-chars) : text;
}
