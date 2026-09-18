import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Collaboration } from '../src/core.js';

const cli = fileURLToPath(new URL('../bin/model-collab.js', import.meta.url));
const decoded = result => {
  assert.equal(result.isError, undefined, result.content[0]?.text);
  return JSON.parse(result.content[0].text);
};

test('two real MCP clients exchange sealed proposals and converge with fixed participant identities', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-collab-mcp-'));
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    await fs.rm(root, { recursive: true, force: true });
  });
  await new Collaboration(root).init();
  for (const agent of ['codex', 'claude']) {
    const client = new Client({ name: `test-${agent}`, version: '1.0.0' });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'serve', '--repo', root, '--agent', agent], stderr: 'pipe' }));
    assert.match(client.getInstructions(), new RegExp(`equal peer ${agent}`));
  }
  const [codex, claude] = clients;
  const tools = (await codex.listTools()).tools.map(tool => tool.name);
  assert.deepEqual(tools.sort(), ['collab_claim', 'collab_post', 'collab_release', 'collab_start', 'collab_status', 'collab_stop', 'collab_verify', 'collab_wait']);
  const started = decoded(await claude.callTool({ name: 'collab_start', arguments: { topic: 'Agree on half-open interval overlap' } }));
  const sessionId = started.session.id;
  const first = decoded(await codex.callTool({ name: 'collab_post', arguments: {
    sessionId,
    clientMessageId: 'mcp-codex-proposal', kind: 'proposal', summary: 'Use strict inequality', evidence: ['Adjacent intervals share no included point.'], solution: 'max(start) < min(end)',
  } }));
  const sealed = decoded(await claude.callTool({ name: 'collab_status', arguments: {} }));
  assert.deepEqual(sealed.session.messages, []);
  assert.deepEqual(sealed.session.candidates, []);
  const rejected = await codex.callTool({ name: 'collab_post', arguments: {
    sessionId,
    clientMessageId: 'mcp-codex-too-early', kind: 'evidence', summary: 'Duplicate contribution', evidence: ['No new peer contribution.'],
  } });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /already contributed/);
  decoded(await claude.callTool({ name: 'collab_post', arguments: {
    sessionId,
    clientMessageId: 'mcp-claude-proposal', kind: 'proposal', summary: 'Use nonempty intersection', evidence: ['[1,2) intersects [2,3) in the empty set.'],
  } }));
  const shared = decoded(await codex.callTool({ name: 'collab_status', arguments: {} }));
  assert.deepEqual(shared.session.messages.map(message => message.agent), ['codex', 'claude']);
  for (const [client, agent] of [[codex, 'codex'], [claude, 'claude']]) {
    decoded(await client.callTool({ name: 'collab_post', arguments: {
      sessionId,
      clientMessageId: `mcp-${agent}-acceptance`, kind: 'accept', candidate: first.message.id,
      summary: 'Boundary examples agree', evidence: ['[1,2) and [2,3) do not overlap under strict inequality.'],
    } }));
  }
  const final = decoded(await claude.callTool({ name: 'collab_status', arguments: {} }));
  assert.equal(final.session.status, 'converged');
  assert.equal(final.session.winner, first.message.id);
  assert.deepEqual(final.session.votes, { codex: first.message.id, claude: first.message.id });
});

test('MCP requires an observed session ID and rejects stale proposals and votes after replacement', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-collab-mcp-session-'));
  const collab = new Collaboration(root);
  const client = new Client({ name: 'test-session-binding', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await collab.init();
  const started = await collab.start({ topic: 'Goal A' });
  const sessionId = started.session.id;
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'serve', '--repo', root, '--agent', 'codex'], stderr: 'pipe' }));
  const schema = (await client.listTools()).tools.find(tool => tool.name === 'collab_post').inputSchema;
  assert.ok(schema.required.includes('sessionId'));
  const body = { clientMessageId: 'mcp-session-proposal', contextVersion: 0, kind: 'proposal', summary: 'A candidate for the observed goal.', evidence: ['Reviewed that goal.'] };
  const post = args => client.callTool({ name: 'collab_post', arguments: args });
  const beforeInvalid = await fs.readFile(collab.file, 'utf8');
  for (const args of [body, { ...body, sessionId: '' }, { ...body, sessionId: 'not-a-session-id' }]) {
    const rejected = await post(args);
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /sessionId|UUID/i);
    assert.equal(await fs.readFile(collab.file, 'utf8'), beforeInvalid);
  }
  const original = decoded(await post({ ...body, sessionId }));
  const beforeRetry = await fs.readFile(collab.file, 'utf8');
  const retry = decoded(await post({ ...body, sessionId }));
  assert.equal(retry.duplicate, true);
  assert.deepEqual(retry.message, original.message);
  assert.equal(await fs.readFile(collab.file, 'utf8'), beforeRetry);
  await collab.post('claude', { ...body, clientMessageId: 'mcp-session-peer-a' });
  const staleVote = { clientMessageId: 'mcp-session-old-vote', contextVersion: 0, kind: 'accept', candidate: original.message.id, summary: 'Accept the reviewed candidate.', evidence: ['Reviewed the candidate in goal A.'] };
  await collab.stop('Replace the goal.');
  const replacement = await collab.start({ topic: 'Goal B' });
  assert.notEqual(replacement.session.id, sessionId);
  assert.equal(replacement.session.contextVersion, body.contextVersion);
  const beforeStale = await fs.readFile(collab.file, 'utf8');
  const staleProposal = await post({ ...body, sessionId });
  assert.equal(staleProposal.isError, true);
  assert.match(staleProposal.content[0].text, /Active session changed/);
  assert.equal(await fs.readFile(collab.file, 'utf8'), beforeStale);
  const current = decoded(await post({ ...body, sessionId: replacement.session.id }));
  assert.equal(current.message.id, original.message.id);
  await collab.post('claude', { ...body, clientMessageId: 'mcp-session-peer-b' });
  const beforeVote = await fs.readFile(collab.file, 'utf8');
  for (const stale of [body, staleVote]) {
    const rejected = await post({ ...stale, sessionId });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /Active session changed/);
    assert.equal(await fs.readFile(collab.file, 'utf8'), beforeVote);
  }
  const currentVote = { ...staleVote, clientMessageId: 'mcp-session-new-vote', evidence: ['Independently reviewed the candidate in goal B.'], sessionId: replacement.session.id };
  decoded(await post(currentVote));
  const final = await collab.post('claude', { ...staleVote, clientMessageId: 'mcp-session-peer-vote', evidence: ['Reviewed the candidate in goal B.'] });
  assert.equal(final.status, 'converged');
  assert.equal(decoded(await post(currentVote)).duplicate, true);
});
