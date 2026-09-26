import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Collaboration } from '../src/core.js';
import { POSTS_PER_GOAL } from '../src/board.js';
import { gitProject } from './helpers.js';

let serial = 0;
const proposal = () => ({
  clientMessageId: `board-test-${++serial}`,
  kind: 'proposal',
  summary: 'Proposal backed by a check',
  evidence: ['Ran the spec examples.'],
  solution: `Answer ${serial}.`,
});

async function fixture(t) {
  const root = await gitProject(t, 'model-collab-board-');
  const collab = new Collaboration(root);
  await collab.init();
  await collab.start({ topic: 'Fix the parser.' });
  return { root, collab };
}

const ids = (page) => page.results.map((p) => p.id);

test('posts form channels and threads that can be searched and read', async (t) => {
  const { root, collab } = await fixture(t);
  const root1 = await collab.boardPost('codex', {
    channel: 'findings',
    text: 'The parser rejects EMPTY input with ValueError.',
  });
  assert.deepEqual(
    { id: root1.post.id, thread: root1.post.thread, channel: root1.post.channel },
    { id: 'p1', thread: 'p1', channel: 'findings' },
  );
  const reply = await collab.boardPost('codex', { thread: 'p1', text: 'Same for whitespace.' });
  assert.equal(reply.post.thread, 'p1');
  assert.equal(reply.post.channel, 'findings');
  await collab.boardPost('user', { channel: 'decisions', text: 'Keep the public API.' });

  assert.deepEqual(ids(await collab.boardSearch(undefined, { query: 'empty valueerror' })), ['p1']);
  assert.deepEqual(ids(await collab.boardSearch(undefined, {})), ['p3', 'p2', 'p1']);
  assert.deepEqual(ids(await collab.boardSearch(undefined, { author: 'user' })), ['p3']);
  assert.deepEqual(ids(await collab.boardSearch(undefined, { after: 'p1' })), ['p3', 'p2']);
  assert.deepEqual(ids(await collab.boardSearch(undefined, { channel: 'findings' })), ['p2', 'p1']);

  const threads = await collab.boardThreads(undefined, {});
  assert.deepEqual(
    threads.results.map((t) => [t.thread, t.replies]),
    [
      ['p3', 0],
      ['p1', 1],
    ],
  );
  const thread = await collab.boardReadThread(undefined, { thread: 'p1' });
  assert.equal(thread.root.id, 'p1');
  assert.deepEqual(ids(thread.replies), ['p2']);
  await assert.rejects(collab.boardReadThread(undefined, { thread: 'p2' }), /p2 is a reply/);
  await assert.rejects(collab.boardPost('codex', { thread: 'p2', text: 'x' }), /is a reply/);
  assert.match(await fs.readFile(path.join(root, '.collab', 'BOARD.md'), 'utf8'), /## decisions/);
});

test('a post needs exactly one destination and retries are idempotent', async (t) => {
  const { collab } = await fixture(t);
  await assert.rejects(collab.boardPost('codex', { text: 'Nowhere.' }), /exactly one destination/);
  await assert.rejects(
    collab.boardPost('codex', { text: 'Both.', channel: 'a', thread: 'p1' }),
    /exactly one destination/,
  );
  await assert.rejects(collab.boardPost('codex', { text: 'x', thread: 'p9' }), /Unknown thread/);
  await assert.rejects(collab.boardPost('codex', { text: 'x', channel: 'Bad Name' }), /Channel/);
  await assert.rejects(collab.boardPost('mallory', { text: 'x', channel: 'a' }), /Unknown/);
  const first = await collab.boardPost('codex', {
    channel: 'findings',
    text: 'Fact one.',
    requestId: 'request-0001',
  });
  const retry = await collab.boardPost('codex', {
    channel: 'findings',
    text: 'Fact one.',
    requestId: 'request-0001',
  });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.post.id, first.post.id);
  await assert.rejects(
    collab.boardPost('codex', {
      channel: 'findings',
      text: 'Fact two.',
      requestId: 'request-0001',
    }),
    /already used for a different post/,
  );
  await assert.rejects(
    collab.boardPost('codex', { channel: 'findings', text: 'Fact one.' }),
    /already posted this text/,
  );
  assert.equal((await collab.boardSearch(undefined, {})).results.length, 1);
});

test("a peer's posts stay sealed until both peers have proposed", async (t) => {
  const { collab } = await fixture(t);
  await collab.boardPost('user', { channel: 'decisions', text: 'Keep the public API.' });
  await collab.boardPost('codex', { channel: 'findings', text: 'Empty input must raise.' });
  await collab.boardPost('codex', { thread: 'p1', text: 'The API includes parse_all.' });

  assert.deepEqual(ids(await collab.boardSearch('claude', {})), ['p1']);
  assert.deepEqual(ids((await collab.boardReadThread('claude', { thread: 'p1' })).replies), []);
  await assert.rejects(collab.boardReadPost('claude', { post: 'p2' }), /Unknown post p2/);
  await assert.rejects(collab.boardPost('claude', { thread: 'p2', text: 'x' }), /Unknown thread/);
  const sealed = (await collab.status('claude')).board;
  assert.equal(sealed.posts, 1);
  assert.deepEqual(
    sealed.newForYou.posts.map((p) => p.id),
    ['p1'],
  );
  assert.deepEqual(ids(await collab.boardSearch('codex', {})), ['p3', 'p2', 'p1']);

  await collab.post('codex', proposal());
  await collab.post('claude', proposal());
  assert.deepEqual(ids(await collab.boardSearch('claude', {})), ['p3', 'p2', 'p1']);
  const open = (await collab.status('claude')).board;
  assert.deepEqual(
    open.newForYou.posts.map((p) => p.id),
    ['p3', 'p2', 'p1'],
  );
  assert.equal(open.newForYou.posts[0].currentGoal, true);
});

test('BOARD.md never shows sealed posts, and a reply inherits its thread’s seal', async (t) => {
  const { root, collab } = await fixture(t);
  const file = path.join(root, '.collab', 'BOARD.md');
  await collab.boardPost('codex', { channel: 'findings', text: 'SEALED_CODEX_DETAIL' });
  await collab.boardPost('user', { thread: 'p1', text: 'User reply to the sealed post.' });
  await collab.boardPost('user', { channel: 'decisions', text: 'Keep the API.' });
  const sealedView = await fs.readFile(file, 'utf8');
  assert.doesNotMatch(sealedView, /SEALED_CODEX_DETAIL|User reply to the sealed post/);
  assert.match(sealedView, /Keep the API/);

  assert.deepEqual(ids(await collab.boardSearch('claude', {})), ['p3']);
  assert.deepEqual(
    (await collab.boardThreads('claude', {})).results.map((t) => t.thread),
    ['p3'],
  );
  await assert.rejects(
    collab.boardReadThread('claude', { thread: 'p2' }),
    /^Error: Unknown thread p2\.$/,
  );
  await assert.rejects(collab.boardReadPost('claude', { post: 'p2' }), /Unknown post p2/);
  assert.deepEqual(
    (await collab.boardReadThread('codex', { thread: 'p1' })).replies.results.map((p) => p.id),
    ['p2'],
  );

  await collab.post('codex', proposal());
  await collab.post('claude', proposal());
  assert.match(await fs.readFile(file, 'utf8'), /SEALED_CODEX_DETAIL[\s\S]*User reply/);
  assert.deepEqual(ids(await collab.boardSearch('claude', {})), ['p3', 'p2', 'p1']);
});

test('board posts persist into later goals and do not change the session', async (t) => {
  const { collab } = await fixture(t);
  const before = (await collab.status()).revision;
  await collab.boardPost('codex', { channel: 'findings', text: 'Tests need GOCACHE.' });
  assert.equal((await collab.status()).revision, before);
  await collab.stop('Next goal.');
  await collab.start({ topic: 'Fix the lexer.' });
  const board = (await collab.status('claude')).board;
  assert.deepEqual(
    board.recentThreads.map((t) => [t.thread, t.root.currentGoal]),
    [['p1', false]],
  );
  assert.deepEqual(board.newForYou, { total: 0, posts: [] });
  assert.deepEqual(ids(await collab.boardSearch('claude', { query: 'gocache' })), ['p1']);
});

test('peers get a per-goal post budget and cannot post while paused', async (t) => {
  const { collab } = await fixture(t);
  for (let i = 0; i < POSTS_PER_GOAL; i++)
    await collab.boardPost('codex', { channel: 'findings', text: `Finding ${i}.` });
  await assert.rejects(
    collab.boardPost('codex', { channel: 'findings', text: 'One more.' }),
    /Board limit reached/,
  );
  await collab.boardPost('claude', { channel: 'findings', text: 'Mine.' });
  await collab.pause();
  await assert.rejects(
    collab.boardPost('claude', { channel: 'findings', text: 'While paused.' }),
    /paused/,
  );
  await collab.boardPost('user', { channel: 'findings', text: 'The user can still post.' });
});

test('long posts are read in Unicode character slices and pages respect a budget', async (t) => {
  const { collab } = await fixture(t);
  const text = '😀'.repeat(5000) + 'end';
  await collab.boardPost('user', { channel: 'long', text });
  const first = await collab.boardReadPost(undefined, { post: 'p1', limit: 4999 });
  assert.equal(first.chars, 5003);
  assert.equal(first.nextOffset, 4999);
  const rest = await collab.boardReadPost(undefined, { post: 'p1', offset: first.nextOffset });
  assert.equal(rest.text, '😀end');
  assert.equal(rest.nextOffset, null);

  for (let i = 0; i < 8; i++)
    await collab.boardPost('user', { channel: 'long', text: `${i} ${'x'.repeat(4000)}` });
  const seen = [];
  let cursor;
  do {
    const page = await collab.boardSearch(undefined, { channel: 'long', maxChars: 4000, cursor });
    assert.ok(JSON.stringify(page.results).length <= 20000 || page.results.length === 1);
    assert.ok(page.results.length < 9);
    seen.push(...ids(page));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, ['p9', 'p8', 'p7', 'p6', 'p5', 'p4', 'p3', 'p2', 'p1']);
  const preview = (await collab.boardSearch(undefined, { query: 'end' })).results[0];
  assert.equal(preview.truncated, true);
  assert.equal(Array.from(preview.text).length, 1000);
});

test('a partial line from an interrupted append does not break the board', async (t) => {
  const { root, collab } = await fixture(t);
  await collab.boardPost('user', { channel: 'findings', text: 'Complete post.' });
  await fs.appendFile(path.join(root, '.collab', 'board.jsonl'), '{"seq":2,"id":"p2","tex');
  const next = await collab.boardPost('user', { channel: 'findings', text: 'After the crash.' });
  assert.equal(next.post.id, 'p2');
  assert.deepEqual(ids(await collab.boardSearch(undefined, {})), ['p2', 'p1']);
});
