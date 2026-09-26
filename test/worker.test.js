import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Collaboration } from '../src/core.js';
import { nativeTurn, runWorker } from '../src/worker.js';
import { runProcess } from '../src/native.js';
import { gitProject } from './helpers.js';

const cli = fileURLToPath(new URL('../bin/model-collab.js', import.meta.url));
const proposal = () => ({
  kind: 'proposal',
  summary: 'Half-open intervals overlap under strict inequality.',
  evidence: ['[1,2) and [2,3) share no included point.'],
  solution: 'max(start) < min(end)',
});
const blocked = () => ({
  kind: 'blocked',
  summary: 'Fixture completed; no further work required.',
  evidence: [],
});
const post = (collab, agent, body) =>
  collab.post(agent, { ...body, clientMessageId: randomUUID() });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

async function fixture(t, config = {}) {
  const root = await gitProject(t, 'model-collab-worker-');
  const collab = new Collaboration(root);
  await collab.init(config);
  await collab.start({ topic: 'Implement interval overlap with half-open boundaries.' });
  return { root, collab };
}

async function expireFixture(collab) {
  await collab.transaction((state) => {
    state.session.deadlineAt = new Date(Date.now() - 1000).toISOString();
  });
}

async function assertViews(collab) {
  const state = JSON.parse(await fs.readFile(collab.file, 'utf8'));
  const markdown = await fs.readFile(path.join(collab.dir, 'README.md'), 'utf8');
  const jsonl = await fs.readFile(path.join(collab.dir, 'messages.jsonl'), 'utf8');
  assert.equal(markdown, collab.renderTranscript(state, 'markdown'));
  assert.equal(jsonl, collab.renderTranscript(state, 'jsonl'));
  assert.deepEqual(
    jsonl.trim() ? jsonl.trim().split('\n').map(JSON.parse) : [],
    state.session?.messages ?? [],
  );
  return { state, markdown, jsonl };
}

test(
  'two workers solve in their own workspaces and converge on the first acceptance',
  { timeout: 5000 },
  async (t) => {
    const { root, collab } = await fixture(t);
    const observed = [],
      events = [];
    const turn = async ({ agent, state }) => {
      observed.push({ agent, state });
      assert.equal(state.session.workspace, path.join(root, '.collab', 'work', agent));
      if (state.session.phase === 'independent') {
        assert.equal(state.session.messages.length, 0);
        assert.equal(state.session.candidates.length, 0);
        await fs.writeFile(path.join(state.session.workspace, `${agent}.txt`), agent);
        return proposal();
      }
      const peer = state.session.candidates.find((candidate) => candidate.agent !== agent);
      return {
        kind: 'accept',
        summary: 'Agree after checking adjacency.',
        candidate: peer.id,
        evidence: ['Strict inequality rejects [1,2) / [2,3).'],
      };
    };
    const results = await Promise.all(
      ['codex', 'claude'].map((agent) =>
        runWorker({ root, agent, turn, onEvent: (event) => events.push(event) }),
      ),
    );
    assert.deepEqual(
      results.map((result) => result.status),
      ['converged', 'converged'],
    );
    assert.ok(observed.length >= 3 && observed.length <= 4);
    assert.equal(events.filter((event) => event.event === 'complete').length, 2);
    assert.equal(events.filter((event) => event.event === 'sent').length, 3);
    const { state } = await assertViews(collab);
    assert.equal(state.session.messages.length, 3);
    const winner = state.session.candidates.find((c) => c.id === state.session.winner);
    assert.deepEqual(state.session.applied.files, [`${winner.agent}.txt`]);
    assert.equal(await fs.readFile(path.join(root, `${winner.agent}.txt`), 'utf8'), winner.agent);
  },
);

test(
  "a peer's acceptance cancels the other worker's in-flight turn",
  { timeout: 5000 },
  async (t) => {
    const { root, collab } = await fixture(t);
    await post(collab, 'codex', proposal());
    await post(collab, 'claude', proposal());
    const events = [];
    let aborted = false;
    const waiting = runWorker({
      root,
      agent: 'claude',
      onEvent: (event) => events.push(event),
      turn: ({ signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await post(collab, 'codex', {
      kind: 'accept',
      candidate: 'm2',
      summary: 'Peer candidate passes my tests.',
      evidence: ['Ran my six boundary cases against m2.'],
    });
    const result = await waiting;
    assert.equal(aborted, true);
    assert.equal(result.status, 'converged');
    assert.equal(result.calls, 1);
    assert.ok(events.some((event) => event.event === 'cancelled'));
  },
);

test(
  'waiting worker makes no model calls until a peer advances the round',
  { timeout: 5000 },
  async (t) => {
    const { root, collab } = await fixture(t);
    await post(collab, 'codex', proposal());
    const sent = deferred();
    let calls = 0;
    const running = runWorker({
      root,
      agent: 'codex',
      turn: async () => {
        calls++;
        return {
          kind: 'accept',
          candidate: 'm1',
          summary: 'The boundary examples pass.',
          evidence: ['Touching intervals do not overlap.'],
        };
      },
      onEvent: (event) => {
        if (event.event === 'sent') sent.resolve();
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(calls, 0);
    await post(collab, 'claude', proposal());
    await sent.promise;
    assert.equal(calls, 1);
    await post(collab, 'claude', {
      kind: 'accept',
      candidate: 'm1',
      summary: 'Independent review agrees.',
      evidence: ['Overlap predicate handles equal endpoints.'],
    });
    assert.equal((await running).status, 'converged');
    assert.equal(calls, 1);
  },
);

test(
  'duplicate worker cannot consume a turn; the lock releases after completion',
  { timeout: 5000 },
  async (t) => {
    const { root } = await fixture(t);
    const entered = deferred(),
      finish = deferred();
    let duplicateCalls = 0;
    const running = runWorker({
      root,
      agent: 'codex',
      turn: async () => {
        entered.resolve();
        return finish.promise;
      },
    });
    await entered.promise;
    try {
      await assert.rejects(
        runWorker({
          root,
          agent: 'codex',
          turn: async () => {
            duplicateCalls++;
            return blocked();
          },
        }),
        /already being held|ELOCKED/i,
      );
    } finally {
      finish.resolve(blocked());
    }
    assert.equal((await running).status, 'blocked');
    assert.equal(duplicateCalls, 0);
    const terminal = await runWorker({
      root,
      agent: 'codex',
      turn: async () => {
        throw new Error('Terminal worker must not call a model');
      },
    });
    assert.equal(terminal.status, 'blocked');
    assert.equal(terminal.calls, 0);
  },
);

test(
  'transport failures surface once; a rejected message gets exactly one correction',
  { timeout: 5000 },
  async (t) => {
    for (const invalid of [false, true]) {
      const { root, collab } = await fixture(t);
      let calls = 0;
      const rejections = [];
      await assert.rejects(
        runWorker({
          root,
          agent: 'codex',
          turn: async ({ rejection }) => {
            calls++;
            rejections.push(rejection);
            if (invalid) return { ...proposal(), kind: 'invented-message-kind' };
            throw new Error('Simulated model transport failure');
          },
        }),
        invalid ? /Invalid option|Invalid enum|Invalid input/ : /Simulated model transport failure/,
      );
      assert.equal(calls, invalid ? 2 : 1);
      if (invalid) {
        assert.equal(rejections[0], null);
        assert.match(rejections[1], /Invalid option|Invalid enum|Invalid input/);
      }
      assert.equal((await collab.status()).session.messages.length, 0);
      const retryByUser = await runWorker({ root, agent: 'codex', turn: async () => blocked() });
      assert.equal(retryByUser.calls, 1);
      assert.equal(retryByUser.status, 'blocked');
    }
  },
);

test(
  'a corrected message after a protocol rejection is posted and the session continues',
  { timeout: 5000 },
  async (t) => {
    const { root, collab } = await fixture(t);
    const events = [];
    const turns = [];
    const result = await runWorker({
      root,
      agent: 'codex',
      onEvent: (event) => {
        events.push(event);
        if (event.event === 'sent') post(collab, 'claude', blocked());
      },
      turn: async ({ rejection }) => {
        turns.push(rejection);
        if (turns.length === 1)
          return { kind: 'accept', candidate: 'm1', summary: 'Premature.', evidence: ['None.'] };
        return proposal();
      },
    });
    assert.equal(turns.length, 2);
    assert.equal(turns[0], null);
    assert.match(turns[1], /independent proposal/);
    assert.deepEqual(result, { status: 'blocked', winner: null, calls: 2 });
    const state = await collab.status();
    assert.deepEqual(
      state.session.messages.map((message) => [message.agent, message.kind]),
      [
        ['codex', 'proposal'],
        ['claude', 'blocked'],
      ],
    );
    assert.equal(events.filter((event) => event.event === 'rejected').length, 1);
  },
);

test(
  'terminal sessions and expired deadlines do not invoke models',
  { timeout: 5000 },
  async (t) => {
    for (const expired of [false, true]) {
      const { root, collab } = await fixture(t);
      if (expired) await expireFixture(collab);
      else await collab.stop('User stopped the goal.');
      const result = await runWorker({
        root,
        agent: 'codex',
        turn: async () => {
          throw new Error('Unexpected paid turn');
        },
      });
      assert.equal(result.calls, 0);
      assert.equal(result.status, expired ? 'exhausted' : 'stopped');
      await assertViews(collab);
    }
  },
);

test(
  'stop and deadline changes during a turn discard output and return a terminal result',
  { timeout: 5000 },
  async (t) => {
    for (const expired of [false, true]) {
      const { root, collab } = await fixture(t);
      let calls = 0;
      const result = await runWorker({
        root,
        agent: 'codex',
        timeoutMs: 90000,
        turn: async ({ timeoutMs }) => {
          calls++;
          assert.ok(timeoutMs > 0 && timeoutMs <= 90000);
          if (expired) await expireFixture(collab);
          else await collab.stop('Stop arrived while the peer was thinking.');
          return proposal();
        },
      });
      assert.equal(calls, 1);
      assert.equal(result.status, expired ? 'exhausted' : 'stopped');
      assert.equal((await collab.status()).session.messages.length, 0);
      await assertViews(collab);
    }
  },
);

test('aborting an in-flight turn never posts its result', { timeout: 5000 }, async (t) => {
  const { root, collab } = await fixture(t);
  const controller = new AbortController();
  const result = await runWorker({
    root,
    agent: 'codex',
    signal: controller.signal,
    turn: async ({ signal }) => {
      assert.equal(signal.aborted, false);
      controller.abort();
      assert.equal(signal.aborted, true);
      return proposal();
    },
  });
  assert.equal(result.status, 'interrupted');
  assert.equal(result.calls, 1);
  assert.equal((await collab.status()).session.messages.length, 0);
  const restarted = await runWorker({ root, agent: 'codex', turn: async () => blocked() });
  assert.equal(restarted.status, 'blocked');
});

test(
  'aborting a native process kills its child instead of leaving it running',
  { timeout: 5000 },
  async (t) => {
    const { root } = await fixture(t);
    const pidFile = path.join(root, 'child.pid');
    const controller = new AbortController();
    const running = runProcess(
      process.execPath,
      [
        '-e',
        'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);',
        pidFile,
      ],
      {
        cwd: root,
        timeoutMs: 4000,
        signal: controller.signal,
      },
    );
    let childPid, abortedAt;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          childPid = Number(await fs.readFile(pidFile, 'utf8'));
          break;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(childPid > 0, 'Child must start before testing cancellation');
    } finally {
      abortedAt = Date.now();
      controller.abort();
    }
    const result = await running;
    assert.equal(result.error, 'aborted');
    assert.ok(
      Date.now() - abortedAt < 1500,
      'Cancellation must not wait for the four-second process timeout',
    );
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
  },
);

test(
  'a turn from the previous goal cannot post into a replacement session',
  { timeout: 5000 },
  async (t) => {
    const { root, collab } = await fixture(t);
    await assert.rejects(
      runWorker({
        root,
        agent: 'codex',
        turn: async () => {
          await collab.stop('Replace the goal.');
          await collab.start({ topic: 'Different problem with a different expected answer.' });
          return proposal();
        },
      }),
      /session changed/i,
    );
    const state = await collab.status();
    assert.equal(state.session.topic, 'Different problem with a different expected answer.');
    assert.equal(state.session.messages.length, 0);
  },
);

test('live README and JSONL track committed state and refresh repairs derived files', async (t) => {
  const { collab } = await fixture(t);
  await assertViews(collab);
  const body = { ...proposal(), clientMessageId: randomUUID() };
  await collab.post('codex', body);
  const first = await assertViews(collab);
  assert.match(first.markdown, /Half-open intervals/);
  assert.equal(first.state.session.phase, 'independent');
  assert.equal((await collab.status('claude')).session.messages.length, 0);
  await collab.post('codex', body);
  assert.equal((await assertViews(collab)).state.revision, first.state.revision);
  await post(collab, 'claude', proposal());
  await collab.stop('End of transcript test.');
  const complete = await assertViews(collab);
  assert.match(complete.markdown, /Status: \*\*stopped\*\*/);
  await fs.writeFile(path.join(collab.dir, 'README.md'), 'Corrupt derived view');
  await fs.writeFile(path.join(collab.dir, 'messages.jsonl'), '{broken');
  await collab.refreshViews();
  assert.equal((await assertViews(collab)).state.revision, complete.state.revision);
  await collab.start({ topic: 'A fresh session' });
  const next = await assertViews(collab);
  assert.equal(next.jsonl.trim(), '');
  assert.doesNotMatch(next.markdown, /Half-open intervals/);
});

test(
  'worker MCP connections expose status, review, verification and the board without posting or lifecycle tools',
  { timeout: 5000 },
  async (t) => {
    const { root } = await fixture(t);
    const client = new Client({ name: 'worker-test', version: '1.0.0' });
    t.after(() => client.close());
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, 'serve', '--repo', root, '--agent', 'codex', '--worker-tools'],
        stderr: 'pipe',
      }),
    );
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(tools, [
      'collab_board_post',
      'collab_board_read_post',
      'collab_board_read_thread',
      'collab_board_search',
      'collab_board_threads',
      'collab_checkout',
      'collab_diff',
      'collab_status',
      'collab_verify',
    ]);
  },
);

test('an unattended Codex turn ignores the user config and execpolicy rules', async (t) => {
  const { root, collab } = await fixture(t);
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'model-collab-fake-codex-'));
  t.after(() => fs.rm(bin, { recursive: true, force: true }));
  const argvFile = path.join(bin, 'argv.json');
  // A stand-in codex that records its arguments and answers with a proposal.
  await fs.writeFile(
    path.join(bin, 'codex'),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(args));
fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], ${JSON.stringify(JSON.stringify(proposal()))});
`,
    { mode: 0o755 },
  );
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous}`;
  t.after(() => {
    process.env.PATH = previous;
  });
  const logDir = path.join(root, '.collab', 'workers', 'codex');
  await fs.mkdir(logDir, { recursive: true });
  const message = await nativeTurn({
    root,
    agent: 'codex',
    state: await collab.status('codex'),
    timeoutMs: 10000,
    logDir,
  });
  assert.equal(message.kind, 'proposal');
  const argv = JSON.parse(await fs.readFile(argvFile, 'utf8'));
  for (const flag of ['--ignore-user-config', '--ignore-rules', '--ephemeral'])
    assert.ok(argv.includes(flag), `missing ${flag}`);
  assert.equal(argv[argv.indexOf('--sandbox') + 1], 'workspace-write');
  assert.ok(argv.includes('web_search="disabled"'));
});
