import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ChatClient,
  ensureChannel,
  provisionUsers,
  readTranscript,
  startServer,
  stopStaleServer,
} from '../src/chat.js';

const installed = spawnSync('swarmchat', ['--version']).status === 0;
const skip = installed ? false : 'swarmchat is not installed';

async function server(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-collab-chat-'));
  const chat = await startServer({ dataDir });
  t.after(async () => {
    await chat.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, chat };
}

test(
  'agents exchange channel posts and direct messages through the server',
  { skip },
  async (t) => {
    const { dataDir, chat } = await server(t);
    assert.match(chat.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const tokens = await provisionUsers({ dataDir, ids: ['model-collab', 'claude-1', 'codex-1'] });
    const system = new ChatClient({ url: chat.url, token: tokens['model-collab'] });
    const claude = new ChatClient({ url: chat.url, token: tokens['claude-1'] });
    const codex = new ChatClient({ url: chat.url, token: tokens['codex-1'] });

    await ensureChannel(system, 'general', ['model-collab', 'claude-1']);
    await ensureChannel(system, 'general', ['model-collab', 'claude-1', 'codex-1']);
    const general = await system.info('general');
    assert.deepEqual(general.members.map((m) => m.id).sort(), [
      'claude-1',
      'codex-1',
      'model-collab',
    ]);
    assert.equal(await system.info('nowhere'), null);

    const goal = await system.send('#general', '  Goal: build the parser  \n');
    assert.equal(goal.text, 'Goal: build the parser');
    const claim = await claude.send('#general', 'I take the lexer -- tests in tests/lexer', {
      replyTo: goal.id,
    });
    await claude.send('codex-1', 'Can you take the CLI?');

    const unread = await codex.read();
    assert.deepEqual(
      unread.map((m) => [m.from, m.text]),
      [
        ['model-collab', 'Goal: build the parser'],
        ['claude-1', 'I take the lexer -- tests in tests/lexer'],
        ['claude-1', 'Can you take the CLI?'],
      ],
    );
    assert.deepEqual(await codex.read(), [], 'reading marks messages read');
    assert.deepEqual(await codex.wait({ timeoutSeconds: 1 }), [], 'a quiet wait times out empty');

    const peeked = codex.wait({ timeoutSeconds: 10, peek: true });
    await claude.send('#general', 'Lexer pushed in abc123');
    assert.equal((await peeked)[0].text, 'Lexer pushed in abc123');
    assert.equal((await codex.read()).length, 1, 'a peek leaves the message unread');

    const chats = await codex.chats();
    assert.ok(chats.some((c) => c.title === '#general'));
    await assert.rejects(codex.send('#general', '   '), /needs text/);

    const transcript = await readTranscript(dataDir);
    assert.deepEqual(
      transcript.map((m) => [m.chat, m.from, m.text]),
      [
        ['#general', 'model-collab', 'Goal: build the parser'],
        ['#general', 'claude-1', 'I take the lexer -- tests in tests/lexer'],
        ['claude-1,codex-1', 'claude-1', 'Can you take the CLI?'],
        ['#general', 'claude-1', 'Lexer pushed in abc123'],
      ],
    );
    assert.equal(transcript[1].replyTo, goal.id);
    assert.equal(transcript[1].id, claim.id);
    const later = await readTranscript(dataDir, { since: transcript[2].at });
    assert.equal(later.length, 2);
  },
);

test('provisioning an existing user replaces its token', { skip }, async (t) => {
  const { dataDir, chat } = await server(t);
  const first = await provisionUsers({ dataDir, ids: ['claude-1'] });
  const second = await provisionUsers({ dataDir, ids: ['claude-1'] });
  assert.notEqual(first['claude-1'], second['claude-1']);
  const stale = new ChatClient({ url: chat.url, token: first['claude-1'] });
  await assert.rejects(stale.chats(), /swarmchat chats/);
  const fresh = new ChatClient({ url: chat.url, token: second['claude-1'] });
  assert.deepEqual(await fresh.chats(), []);
});

test('a stale server is stopped only when its PID is still SwarmChat', { skip }, async (t) => {
  assert.equal(await stopStaleServer(process.pid), false);
  assert.equal(await stopStaleServer(null), false);
  const { chat } = await server(t);
  assert.equal(await stopStaleServer(chat.pid), true);
});

test('starting fails clearly when the server command is missing', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-collab-chat-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await assert.rejects(
    startServer({ command: 'model-collab-no-such-swarmchat', dataDir }),
    /Could not start model-collab-no-such-swarmchat/,
  );
});
