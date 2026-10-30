import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import {
  clearMemory,
  goalRecord,
  pendingGoals,
  redactSecrets,
  updateMemory,
  validateMemory,
} from '../src/memory.js';
import { gitProject } from './helpers.js';

const memory = (history, knowledge = '- none yet') =>
  `# Project memory\n## User preferences\n- none yet\n## Project knowledge\n${knowledge}\n## Pitfalls\n- none yet\n## Goal history\n${history}\n`;

let clock = Date.parse('2026-10-30T10:00:00Z');
function finishedRun(goal, fields = {}) {
  const createdAt = new Date((clock += 60000)).toISOString();
  return {
    kind: 'swarm',
    id: randomUUID(),
    goal,
    criteria: [],
    status: 'finished',
    stopReason: 'every agent is waiting and the checks pass',
    createdAt,
    endedAt: new Date((clock += 60000)).toISOString(),
    deadlineAt: createdAt,
    agents: [
      {
        id: 'claude-1',
        state: 'stopped',
        sessions: 1,
        usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 },
        lastSummary: null,
        retiredReason: null,
      },
    ],
    checkRounds: [],
    notes: [],
    result: { commit: 'a'.repeat(40), commits: 1, files: ['x.js'], applied: ['x.js'], error: null },
    ...fields,
  };
}

/** A project whose finished runs are in history, the last one still in state.json. */
async function finishedGoals(t, goals, config = {}) {
  const root = await gitProject(t, 'model-collab-memory-');
  const store = new Store(root);
  await store.init(config);
  await addRuns(store, goals);
  return { root, store };
}

async function addRuns(store, goals) {
  for (const goal of goals) {
    const { run } = await store.read();
    await store.archiveRun(run);
    await store.update((state) => {
      state.run = finishedRun(goal);
    });
  }
}

test('memory must keep the required headings in order and stay small', () => {
  validateMemory(memory('- 2026-09-27 goal: converged'));
  assert.throws(() => validateMemory('# Notes\n'), /must start with # Project memory/);
  assert.throws(
    () => validateMemory(memory('- x').replace('## Pitfalls\n', '')),
    /missing "## Pitfalls"/,
  );
  assert.throws(
    () =>
      validateMemory(
        '# Project memory\n## User preferences\n## Project knowledge\n## Goal history\n## Pitfalls\n',
      ),
    /missing "## Goal history" in order/,
  );
  assert.throws(() => validateMemory(memory('x'.repeat(10001))), /limit is 10000/);
});

test('secrets are redacted before memory is stored', () => {
  const text = redactSecrets(
    'key sk-abcdefghijklmnopqrstuv, Bearer abcdefghijklmnopqrstuvwxyz, AKIAABCDEFGHIJKLMNOP, password=hunter22, ghp_abcdefghijklmnopqrstuvwxyz12',
  );
  assert.doesNotMatch(text, /sk-abc|abcdefghijklmnopqrstuvwxyz|AKIAABC|hunter22|ghp_/);
  assert.match(text, /password=\[REDACTED\]/);
  for (const safe of [
    'run `npm test` with PORT=3000',
    'Run tests with `TOKEN=dummy123 npm test`.',
    'export API_KEY=local-dev-only before running.',
    'const secret = process.env.SECRET_KEY;',
    'const password = process.env.DB_PASSWORD;',
    'secret=${SECRET}',
  ])
    assert.equal(redactSecrets(safe), safe);
  assert.equal(redactSecrets('token: "a8f3kd92jf83kdl2"'), 'token: "[REDACTED]"');
});

test('a goal record carries the outcome, team, checks, notes, summaries, and chat', () => {
  const run = finishedRun('Fix the lexer.', {
    id: 'run-1',
    criteria: ['No regressions.'],
    status: 'stopped',
    stopReason: 'stopped by the user',
    notes: [{ at: '2026-10-30T10:00:30Z', text: 'Keep tokens immutable.' }],
    agents: [
      { id: 'claude-1', sessions: 3, lastSummary: 'Lexer pushed in abc123.', retiredReason: null },
      {
        id: 'codex-1',
        sessions: 5,
        lastSummary: null,
        retiredReason: '5 failed sessions in a row',
      },
    ],
    checkRounds: [
      {
        commit: 'b'.repeat(40),
        results: [{ name: 'test', passed: false, code: 1, error: null, output: '1 failing' }],
      },
    ],
    result: { commit: 'c'.repeat(40), commits: 4, files: ['lexer.js'], applied: null, error: null },
  });
  const record = goalRecord(run, [
    { chat: '#general', from: 'claude-1', text: 'I take the lexer.' },
    { chat: 'claude-1,codex-1', from: 'codex-1', text: 'Run tests with make test.' },
  ]);
  assert.match(record, /run run-1/);
  assert.match(record, /Fix the lexer\.[\s\S]*No regressions\./);
  assert.match(
    record,
    /Outcome: stopped \(stopped by the user\)\. 4 commits on the swarm's main; not applied\./,
  );
  assert.match(record, /codex-1 \(5 sessions, retired: 5 failed sessions in a row\)/);
  assert.match(record, /User notes:\n- Keep tokens immutable\./);
  assert.match(record, /- test: failed \(exit 1\)\n {2}1 failing/);
  assert.match(record, /- claude-1: Lexer pushed in abc123\./);
  assert.match(record, /- \[claude-1,codex-1\] codex-1: Run tests with make test\./);
});

test('finished goals are remembered once, oldest first, and the user’s edits reach the model', async (t) => {
  const { root } = await finishedGoals(t, ['Goal one.', 'Goal two.']);
  const inputs = [];
  const call = async ({ input }) => {
    inputs.push(input);
    const goal = input.match(/FINISHED GOAL RECORD[^\n]*\n[^\n]*\n(.*)/)[1];
    return { changed: true, memory: memory(`- ${goal}`) };
  };
  const first = await updateMemory(root, { call });
  assert.equal(first.consolidated.length, 2);
  assert.match(inputs[0], /Goal one\./);
  assert.match(inputs[1], /CURRENT MEMORY\.md\n# Project memory[\s\S]*Goal one\.[\s\S]*Goal two\./);
  assert.deepEqual(await pendingGoals(root), []);
  assert.deepEqual((await updateMemory(root, { call })).consolidated, []);
  assert.equal(inputs.length, 2);

  const file = path.join(root, '.collab', 'MEMORY.md');
  await fs.writeFile(file, memory('- Goal two.', '- Deploys need VPN access. [user]'));
  await addRuns(new Store(root), ['Goal three.']);
  await updateMemory(root, { call });
  assert.match(
    inputs[2],
    /THE USER'S EDITS SINCE THE LAST UPDATE[\s\S]*\+- Deploys need VPN access/,
  );
});

test('an edit to MEMORY.md during the model call wins, and the goal stays pending', async (t) => {
  const { root } = await finishedGoals(t, ['Goal one.']);
  const file = path.join(root, '.collab', 'MEMORY.md');
  const result = await updateMemory(root, {
    call: async () => {
      await fs.writeFile(file, memory('- written by the user meanwhile'));
      return { changed: true, memory: memory('- from the model') };
    },
  });
  assert.deepEqual(result.consolidated, []);
  assert.match(await fs.readFile(file, 'utf8'), /written by the user meanwhile/);
  assert.equal((await pendingGoals(root)).length, 1);
});

test('an update interrupted between its two writes is finished or discarded, never misread', async (t) => {
  const { root } = await finishedGoals(t, ['Goal one.', 'Goal two.']);
  const [one, two] = (await pendingGoals(root)).map((s) => s.id);
  const dir = path.join(root, '.collab');
  const written = memory('- goal one remembered');
  // Crash after MEMORY.md was written: the update is completed, not re-run.
  await fs.writeFile(path.join(dir, 'MEMORY.md'), written);
  await fs.writeFile(
    path.join(dir, 'memory.json'),
    JSON.stringify({
      consolidated: {},
      lastWritten: null,
      pending: { session: one, memory: written },
    }),
  );
  const inputs = [];
  await updateMemory(root, {
    call: async ({ input }) => {
      inputs.push(input);
      return { changed: true, memory: memory('- goal two remembered') };
    },
  });
  assert.equal(inputs.length, 1);
  assert.match(inputs[0], /Goal two\./);
  assert.doesNotMatch(inputs[0], /USER'S EDITS/);
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'memory.json'), 'utf8'));
  assert.ok(meta.consolidated[one] && meta.consolidated[two]);
  assert.equal(meta.pending, undefined);
});

test('an update interrupted before MEMORY.md was written leaves the goal pending', async (t) => {
  const { root } = await finishedGoals(t, ['Goal one.']);
  const [one] = (await pendingGoals(root)).map((s) => s.id);
  await fs.writeFile(
    path.join(root, '.collab', 'memory.json'),
    JSON.stringify({
      consolidated: {},
      lastWritten: null,
      pending: { session: one, memory: memory('- never written') },
    }),
  );
  const inputs = [];
  await updateMemory(root, {
    call: async ({ input }) => {
      inputs.push(input);
      return { changed: true, memory: memory('- goal one remembered') };
    },
  });
  assert.match(inputs[0], /Goal one\./);
  assert.match(
    await fs.readFile(path.join(root, '.collab', 'MEMORY.md'), 'utf8'),
    /goal one remembered/,
  );
});

test('invalid model output is rejected and nothing is written', async (t) => {
  const { root } = await finishedGoals(t, ['Goal one.']);
  await assert.rejects(
    updateMemory(root, { call: async () => ({ changed: true, memory: '# Something else\n' }) }),
    /must start with # Project memory/,
  );
  await assert.rejects(
    updateMemory(root, { call: async () => ({ memory: memory('- x') }) }),
    /invalid response/,
  );
  await assert.rejects(fs.access(path.join(root, '.collab', 'MEMORY.md')));
  assert.equal((await pendingGoals(root)).length, 1);
});

test('memory can be turned off, backlog beyond three goals is skipped, and clearing keeps history', async (t) => {
  const { root, store } = await finishedGoals(t, ['One.', 'Two.', 'Three.', 'Four.', 'Five.']);
  await store.configure({ memory: false });
  assert.deepEqual(await updateMemory(root, { call: assert.fail }), {
    disabled: true,
    consolidated: [],
  });
  await store.configure({ memory: true });
  const seen = [];
  const result = await updateMemory(root, {
    call: async ({ input }) => {
      seen.push(input.match(/FINISHED GOAL RECORD[^\n]*\n[^\n]*\n(.*)/)[1]);
      return { changed: true, memory: memory('- remembered') };
    },
  });
  assert.deepEqual(seen, ['Three.', 'Four.', 'Five.']);
  assert.equal(result.skipped.length, 2);
  await clearMemory(root);
  await assert.rejects(fs.access(path.join(root, '.collab', 'MEMORY.md')));
  assert.deepEqual(await pendingGoals(root), []);
  const history = await fs.readdir(path.join(root, '.collab', 'history'));
  assert.equal(history.filter((name) => name.endsWith('.json')).length, 4);
});
