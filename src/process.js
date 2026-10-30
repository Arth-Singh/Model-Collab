import { spawn } from 'node:child_process';

// No shell interpolation. Kill the process group when a check exceeds its budget.
// Output beyond `maxBytes` per stream is dropped from the front, keeping the tail
// where test runners print their summaries. Only `hardLimitBytes` of total output
// terminates the process, so a verbose but passing suite is not failed for talking.
export function runCommand(
  argv,
  {
    cwd,
    timeoutMs = 60000,
    maxBytes = 128000,
    hardLimitBytes = 64 * 1024 * 1024,
    input,
    env,
    signal,
  } = {},
) {
  if (signal?.aborted)
    return Promise.resolve({
      code: null,
      stdout: '',
      stderr: '',
      truncated: false,
      error: 'aborted',
      durationMs: 0,
    });
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const streams = { stdout: '', stderr: '' };
    let bytes = 0,
      truncated = false,
      reason = null,
      done = false;
    const kill = () => {
      try {
        process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* Already exited. */
      }
    };
    const timer = setTimeout(() => {
      reason = 'timeout';
      kill();
    }, timeoutMs);
    const abort = () => {
      reason = 'aborted';
      kill();
    };
    signal?.addEventListener('abort', abort, { once: true });
    function finish(code, error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve({
        code,
        stdout: streams.stdout,
        stderr: streams.stderr,
        truncated,
        error: error ?? reason,
        durationMs: Date.now() - started,
      });
    }
    function collect(key, chunk) {
      bytes += chunk.length;
      if (bytes > hardLimitBytes) {
        reason = 'output_limit';
        kill();
        return;
      }
      const text = streams[key] + chunk;
      if (text.length > maxBytes) truncated = true;
      streams[key] = text.slice(-maxBytes);
    }
    child.stdout.on('data', (c) => collect('stdout', c));
    child.stderr.on('data', (c) => collect('stderr', c));
    child.on('error', (e) => finish(null, e.message));
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export const DEFAULT_MODELS = Object.freeze({
  codex: 'gpt-6-astra',
  claude: 'claude-opus-5-5',
});
export const DEFAULT_EFFORT = 'high';

/**
 * Run without a shell. Bound output and terminate the whole POSIX process group.
 * With `tailBytes`, keep only the last `tailBytes` of each stream and stop the
 * process only when total output exceeds `maxOutputBytes`; use it when the
 * result arrives another way and the stream is only a log. With `idleMs`, stop
 * with `stalled` when neither stream has written for that long, unless `busy()`
 * reports work in progress.
 */
export function runProcess(command, args = [], options = {}) {
  const {
    cwd,
    input = '',
    timeoutMs = 60_000,
    deadlineMs = Date.now() + timeoutMs,
    maxOutputBytes = 1_000_000,
    tailBytes = null,
    idleMs = null,
    busy = () => false,
    env = process.env,
    signal,
    onLaunch,
  } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(deadlineMs))
    throw new Error('A finite positive timeout and deadline are required');
  const remaining = Math.min(timeoutMs, deadlineMs - Date.now());
  if (remaining <= 0 || signal?.aborted)
    return Promise.resolve({
      code: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: signal?.aborted ? 'aborted' : 'deadline_exceeded',
      wallMs: 0,
      launched: false,
      truncated: false,
    });
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '',
      stderr = '',
      bytes = 0,
      truncated = false,
      failure = null,
      settled = false,
      killTimer,
      idleTimer,
      launched = false;
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const kill = (signal) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* Process already exited. */
      }
    };
    const stop = (reason) => {
      if (failure) return;
      failure = reason;
      kill('SIGTERM');
      killTimer = setTimeout(() => {
        kill('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
        finish(null, 'SIGKILL');
      }, 500);
      killTimer.unref();
    };
    const timer = setTimeout(() => stop('timeout'), remaining);
    const watchIdle = () => {
      if (!idleMs) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => (busy(stdout) ? watchIdle() : stop('stalled')), idleMs);
    };
    watchIdle();
    const abort = () => stop('aborted');
    signal?.addEventListener('abort', abort, { once: true });
    const finish = (code, exitSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(idleTimer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      // A child may exit while a spawned descendant remains alive.
      if (failure) kill('SIGKILL');
      resolve({
        code,
        signal: exitSignal,
        stdout,
        stderr,
        error: failure,
        wallMs: Date.now() - started,
        launched,
        truncated,
      });
    };
    const collect = (name) => (chunk) => {
      bytes += chunk.length;
      watchIdle();
      if (tailBytes) {
        let text = (name === 'stdout' ? stdout : stderr) + chunk.toString('utf8');
        if (text.length > tailBytes) {
          text = text.slice(-tailBytes);
          truncated = true;
        }
        if (name === 'stdout') stdout = text;
        else stderr = text;
      } else {
        const available = Math.max(0, maxOutputBytes - (bytes - chunk.length));
        const text = chunk.subarray(0, available).toString('utf8');
        if (name === 'stdout') stdout += text;
        else stderr += text;
      }
      if (bytes > maxOutputBytes) stop('output_limit');
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.on('spawn', () => {
      launched = true;
      onLaunch?.(child.pid);
    });
    child.on('error', (error) => {
      failure = `spawn_error: ${error.message}`;
      finish(null, null);
    });
    child.on('close', finish);
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
