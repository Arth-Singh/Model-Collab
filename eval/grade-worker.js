import vm from 'node:vm';
import { isDeepStrictEqual } from 'node:util';
import { privateTests } from './private-tests.js';

// A separate process and bounded VM contain accidental hangs. Node VM is not a
// security sandbox for hostile code; use OS/container isolation for that case.
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 256_000) throw new Error('Grading input exceeds size limit');
}
const { taskId, solution, testTimeoutMs = 150 } = JSON.parse(input);
const tests = privateTests(taskId);
function equal(actual, expected, tolerance) {
  if (!tolerance) return isDeepStrictEqual(actual, expected);
  if (typeof expected === 'number') return typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance * (1 + Math.abs(expected));
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((item, i) => equal(actual[i], item, tolerance));
  if (expected && typeof expected === 'object') return actual && typeof actual === 'object' && !Array.isArray(actual) && Object.keys(actual).length === Object.keys(expected).length && Object.keys(expected).every(key => Object.hasOwn(actual, key) && equal(actual[key], expected[key], tolerance));
  return actual === expected;
}
let passed = 0;
const failures = [];
for (const test of tests) {
  try {
    const context = vm.createContext(Object.create(null), {
      codeGeneration: { strings: false, wasm: false },
      microtaskMode: 'afterEvaluate',
    });
    const script = new vm.Script(`"use strict";\n${solution}\n;JSON.stringify(solve(...${JSON.stringify(test.args)}));`);
    const serialized = script.runInContext(context, { timeout: testTimeoutMs });
    const actual = JSON.parse(serialized);
    if (equal(actual, test.expected, test.tolerance)) passed++;
    else failures.push({ name: test.name, reason: 'wrong_answer' });
  } catch (error) {
    failures.push({ name: test.name, reason: error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? 'timeout' : 'runtime_error', message: String(error.message).slice(0, 300) });
  }
}
process.stdout.write(JSON.stringify({ passed, total: tests.length, correct: passed === tests.length, failures }));
