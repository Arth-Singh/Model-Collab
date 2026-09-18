import { spawn } from 'node:child_process';

export const DEFAULT_MODELS = Object.freeze({
  codex: 'gpt-6-astra',
  claude: 'claude-fable-5-1[1m]',
});

/** Run without a shell. Bound output and terminate the whole POSIX process group. */
export function runProcess(command, args = [], options = {}) {
  const {
    cwd,
    input = '',
    timeoutMs = 60_000,
    deadlineMs = Date.now() + timeoutMs,
    maxOutputBytes = 1_000_000,
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
    });
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '',
      stderr = '',
      bytes = 0,
      failure = null,
      settled = false,
      killTimer,
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
    const abort = () => stop('aborted');
    signal?.addEventListener('abort', abort, { once: true });
    const finish = (code, exitSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
      });
    };
    const collect = (name) => (chunk) => {
      const available = Math.max(0, maxOutputBytes - bytes);
      bytes += chunk.length;
      const text = chunk.subarray(0, available).toString('utf8');
      if (name === 'stdout') stdout += text;
      else stderr += text;
      if (bytes > maxOutputBytes) stop('output_limit');
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.on('spawn', () => {
      launched = true;
      onLaunch?.();
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
