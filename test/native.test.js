import test from 'node:test';
import assert from 'node:assert/strict';
import { runProcess } from '../src/native.js';

test('native processes enforce timeout, output cap, and missing executable failure', async () => {
  const timeout = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeoutMs: 80,
  });
  assert.equal(timeout.error, 'timeout');
  const output = await runProcess(
    process.execPath,
    ['-e', 'process.stdout.write("x".repeat(100000))'],
    { maxOutputBytes: 100, timeoutMs: 1000 },
  );
  assert.equal(output.error, 'output_limit');
  assert.ok(output.stdout.length <= 100);
  const missing = await runProcess('/no/such/model-collab-command', [], { timeoutMs: 1000 });
  assert.match(missing.error, /^spawn_error:/);
  const deadline = await runProcess(process.execPath, ['-e', 'process.exit(1)'], {
    deadlineMs: Date.now() - 1,
  });
  assert.equal(deadline.error, 'deadline_exceeded');
});
