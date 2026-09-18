import { spawn } from 'node:child_process';

// No shell interpolation. Kill the process group when a check exceeds its budget.
export function runCommand(argv, { cwd, timeoutMs = 60000, maxBytes = 128000, input, env } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      bytes = 0,
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
    function finish(code, error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, error: error ?? reason, durationMs: Date.now() - started });
    }
    function collect(key, chunk) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reason = 'output_limit';
        kill();
        return;
      }
      if (key === 'stdout') stdout += chunk;
      else stderr += chunk;
    }
    child.stdout.on('data', (c) => collect('stdout', c));
    child.stderr.on('data', (c) => collect('stderr', c));
    child.on('error', (e) => finish(null, e.message));
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
