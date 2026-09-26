import { spawn } from 'node:child_process';

// No shell interpolation. Kill the process group when a check exceeds its budget.
// Output beyond `maxBytes` per stream is dropped from the front, keeping the tail
// where test runners print their summaries. Only `hardLimitBytes` of total output
// terminates the process, so a verbose but passing suite is not failed for talking.
export function runCommand(
  argv,
  { cwd, timeoutMs = 60000, maxBytes = 128000, hardLimitBytes = 64 * 1024 * 1024, input, env } = {},
) {
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
    function finish(code, error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
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
