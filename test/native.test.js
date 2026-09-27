import test from 'node:test';
import assert from 'node:assert/strict';
import { runProcess } from '../src/native.js';

test('native processes enforce timeout, output cap, idle stall, and missing executable failure', async () => {
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
  const tail = await runProcess(
    process.execPath,
    ['-e', 'process.stdout.write("a".repeat(5000) + "END")'],
    { tailBytes: 100, maxOutputBytes: 1_000_000, timeoutMs: 1000 },
  );
  assert.equal(tail.error, null);
  assert.equal(tail.code, 0);
  assert.equal(tail.stdout.length, 100);
  assert.ok(tail.stdout.endsWith('END'));
  assert.equal(tail.truncated, true);
  const silent = ['-e', 'setInterval(() => {}, 1000)'];
  const stalled = await runProcess(process.execPath, silent, { idleMs: 100, timeoutMs: 5000 });
  assert.equal(stalled.error, 'stalled');
  const busy = await runProcess(process.execPath, silent, {
    idleMs: 50,
    busy: () => true,
    timeoutMs: 400,
  });
  assert.equal(busy.error, 'timeout');
  const talking = await runProcess(
    process.execPath,
    [
      '-e',
      'setInterval(() => process.stdout.write("."), 20); setTimeout(() => process.exit(0), 2500)',
    ],
    { idleMs: 1000, timeoutMs: 10000 },
  );
  assert.equal(talking.error, null);
  assert.equal(talking.code, 0);
  const missing = await runProcess('/no/such/model-collab-command', [], { timeoutMs: 1000 });
  assert.match(missing.error, /^spawn_error:/);
  const deadline = await runProcess(process.execPath, ['-e', 'process.exit(1)'], {
    deadlineMs: Date.now() - 1,
  });
  assert.equal(deadline.error, 'deadline_exceeded');
});
