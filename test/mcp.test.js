import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runSwarm } from '../src/swarm.js';
import { gitProject } from './helpers.js';

const skip =
  spawnSync('swarmchat', ['--version']).status === 0 ? false : 'swarmchat is not installed';

async function connect(mcp) {
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({ command: mcp.command, args: mcp.args, stderr: 'pipe' }),
  );
  return client;
}

const call = async (client, name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  return JSON.parse(result.content[0].text);
};

test('agents reach the chat and the run through their own MCP servers', { skip }, async (t) => {
  const root = await gitProject(t, 'model-collab-mcp-');
  const seen = {};
  const session = async ({ agent, mcp }) => {
    const client = await connect(mcp);
    try {
      if (agent.id === 'claude-1' && agent.sessions === 1) {
        const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
        seen.tools = tools;
        seen.instructions = client.getInstructions();
        await call(client, 'chat_read');
        await call(client, 'chat_channel', {
          action: 'create',
          name: 'parser',
          members: ['codex-1'],
        });
        await call(client, 'chat_send', { to: 'codex-1', text: 'Take the parser, @codex-1.' });
        seen.status = await call(client, 'swarm_status');
        seen.check = await call(client, 'swarm_check', { check: 'readme' });
        const missing = await client.callTool({
          name: 'swarm_check',
          arguments: { check: 'nope' },
        });
        seen.missingCheck = missing.content[0].text;
      }
      if (agent.id === 'codex-1') {
        // The direct message may arrive after this agent's first session starts.
        const messages = await call(client, 'chat_wait', { timeoutSeconds: 20, from: 'claude-1' });
        seen.received ??= messages;
        seen.chats ??= await call(client, 'chat_chats');
      }
      await call(client, 'chat_read');
      return {
        next: 'wait',
        summary: 'done',
        usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, costUsd: 0 },
        wallMs: 1,
      };
    } finally {
      await client.close();
    }
  };
  const run = await runSwarm({
    root,
    goal: 'Exercise the tools',
    overrides: {
      claude: 1,
      codex: 1,
      quietSeconds: 1,
      staggerSeconds: 0,
      deadlineMinutes: 2,
      memory: false,
      checks: { readme: ['test', '-f', 'README.md'] },
    },
    session,
  });
  assert.equal(run.status, 'finished', run.stopReason);
  assert.deepEqual(seen.tools, [
    'chat_channel',
    'chat_chats',
    'chat_read',
    'chat_send',
    'chat_wait',
    'swarm_check',
    'swarm_status',
  ]);
  assert.match(seen.instructions, /You are claude-1/);
  assert.equal(seen.status.you.id, 'claude-1');
  assert.equal(seen.status.goal, 'Exercise the tools');
  assert.deepEqual(
    seen.status.teammates.map((a) => a.id),
    ['codex-1'],
  );
  assert.deepEqual(seen.status.checks, { readme: 'test -f README.md' });
  assert.equal(seen.check.passed, true);
  assert.match(seen.missingCheck, /No check named nope/);
  assert.deepEqual(
    seen.received.map((m) => [m.chat, m.from, m.text]),
    [['claude-1,codex-1', 'claude-1', 'Take the parser, @codex-1.']],
  );
  assert.ok(seen.chats.some((c) => c.title === '#parser'));
});
