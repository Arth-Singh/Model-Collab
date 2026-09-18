import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { Collaboration } from './core.js';
import { peerContract, researchContract, serverConfig } from './setup.js';
import { runProcess, DEFAULT_MODELS } from './native.js';

const string = { type: 'string' };
export const TURN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['proposal', 'challenge', 'evidence', 'accept', 'blocked'] },
    summary: string,
    evidence: { type: 'array', items: string },
    candidate: { type: ['string', 'null'] },
    solution: { type: ['string', 'null'] },
    files: { type: 'array', items: string },
    repliesTo: { type: ['string', 'null'] },
    resolves: { type: 'array', items: string },
  },
  required: [
    'kind',
    'summary',
    'evidence',
    'candidate',
    'solution',
    'files',
    'repliesTo',
    'resolves',
  ],
};

function cleanMessage(value) {
  if (typeof value === 'string') value = JSON.parse(value);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Worker response must be a JSON message.');
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null));
}

export async function nativeTurn({
  root,
  agent,
  state,
  timeoutMs,
  model,
  effort = 'xhigh',
  logDir,
  signal,
}) {
  const id = randomUUID();
  const schemaFile = path.join(logDir, `${id}.schema.json`),
    finalFile = path.join(logDir, `${id}.response.json`);
  await fs.writeFile(schemaFile, JSON.stringify(TURN_SCHEMA));
  const config = serverConfig(root, agent);
  config.args.push('--worker-tools');
  const context = (
    await Promise.all(
      ['CONTEXT.md', 'RESEARCH.md', 'BRIEF.md'].map(async (name) => {
        const text = await fs.readFile(path.join(root, '.collab', name), 'utf8').catch((e) => {
          if (e.code === 'ENOENT') return '';
          throw e;
        });
        return text ? `${name}\n${text.slice(0, 16000)}` : '';
      }),
    )
  )
    .filter(Boolean)
    .join('\n\n');
  const research = state.config.preset === 'research' ? researchContract : '';
  const prompt = `${peerContract}\n\n${research}\n\nWORKER TURN CONTRACT (overrides only the interactive send/wait steps):
You are ${agent}. This process performs exactly ONE contribution, then exits. The worker handles delivery and wake-up.
Use collab_status if you need a fresh view; claim files before editing, release after editing, and use collab_verify for configured checks.
Do not call collab_post, collab_start, collab_stop, collab_wait, or the model-collab CLI. Do not read or edit .collab/state.json, README.md, messages.jsonl, history, or worker logs; the filtered view below contains all permitted peer context.
Return the message itself as JSON matching the output schema, with null for unused optional strings. Do not include clientMessageId, sessionId, or contextVersion; the worker binds these to the captured turn.
During independent phase propose your own solution without changing shared source or test files. During discussion follow the peer contract's contribution rules: inspect artifacts, resolve material uncertainty, implement when needed, and accept only a candidate that meets the goal. No need to manufacture a challenge when the evidence supports acceptance.
No background agents or recursive CLI calls. Respect the user's repository scope and normal repository instructions.
\nSHARED CONTEXT\n${context}\n\nFILTERED SESSION\n${JSON.stringify(state)}\n`;
  const args =
    agent === 'codex'
      ? [
          'exec',
          '--ignore-user-config',
          '--ephemeral',
          '--skip-git-repo-check',
          '--sandbox',
          'workspace-write',
          '-c',
          'approval_policy="never"',
          '-c',
          `model_reasoning_effort=${JSON.stringify(effort)}`,
          '-c',
          `mcp_servers.model_collab.command=${JSON.stringify(config.command)}`,
          '-c',
          `mcp_servers.model_collab.args=${JSON.stringify(config.args)}`,
          '--disable',
          'multi_agent',
          '--disable',
          'hooks',
          '--disable',
          'apps',
          '--disable',
          'plugins',
          '--model',
          model ?? DEFAULT_MODELS.codex,
          '--cd',
          root,
          '--output-schema',
          schemaFile,
          '--output-last-message',
          finalFile,
          '--json',
          '-',
        ]
      : [
          '-p',
          '--model',
          model ?? DEFAULT_MODELS.claude,
          '--effort',
          effort,
          '--output-format',
          'json',
          '--json-schema',
          JSON.stringify(TURN_SCHEMA),
          '--strict-mcp-config',
          '--mcp-config',
          JSON.stringify({ mcpServers: { model_collab: config } }),
          '--permission-mode',
          'acceptEdits',
          '--permission-prompts',
          'none',
          '--allowedTools',
          'Read,Glob,Grep,Edit,Write,mcp__model_collab__*',
          '--disable-slash-commands',
          '--no-session-persistence',
          '--no-chrome',
          '--settings',
          '{"disableAllHooks":true}',
        ];
  const result = await runProcess(agent, args, {
    cwd: root,
    input: prompt,
    timeoutMs,
    deadlineMs: Date.parse(state.session.deadlineAt),
    maxOutputBytes: 1000000,
    signal,
  });
  await fs.writeFile(
    path.join(logDir, `${id}.log.json`),
    JSON.stringify(
      { agent, model: model ?? DEFAULT_MODELS[agent], round: state.session.round, ...result },
      null,
      2,
    ),
  );
  if (result.error || result.code !== 0)
    throw new Error(
      `${agent} turn failed: ${result.error ?? `exit ${result.code}`}; see ${logDir}`,
    );
  if (agent === 'codex') return cleanMessage(await fs.readFile(finalFile, 'utf8'));
  const response = JSON.parse(result.stdout);
  if (response.is_error)
    throw new Error(`Claude turn failed: ${response.result ?? response.subtype}`);
  return cleanMessage(response.structured_output ?? response.result);
}

/** The worker waits locally between turns, making no model calls while idle. */
export async function runWorker({
  root,
  agent,
  model,
  effort = 'xhigh',
  timeoutMs = 120000,
  turn = nativeTurn,
  onEvent = () => {},
  signal,
}) {
  if (!['codex', 'claude'].includes(agent)) throw new Error('Workers support codex and claude.');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000)
    throw new Error('Worker timeout must be 1–600000 ms.');
  root = path.resolve(root);
  const collab = new Collaboration(root);
  const initial = await collab.status(agent);
  if (!initial.session) throw new Error('Start a collaboration goal before starting workers.');
  const sessionId = initial.session.id;
  const logDir = path.join(root, '.collab', 'workers', agent);
  await fs.mkdir(logDir, { recursive: true });
  const release = await lockfile.lock(logDir, { realpath: false, retries: 0, stale: 10000 });
  let calls = 0,
    seen = new Set();
  try {
    while (!signal?.aborted) {
      const state = await collab.status(agent),
        s = state.session;
      if (s.id !== sessionId)
        throw new Error('Active session changed; restart the worker for the new goal.');
      for (const message of s.messages)
        if (!seen.has(message.id)) {
          seen.add(message.id);
          onEvent({
            event: 'message',
            agent: message.agent,
            kind: message.kind,
            round: message.round,
            id: message.id,
            summary: message.summary,
          });
        }
      if (s.status !== 'active') {
        onEvent({
          event: 'complete',
          status: s.status,
          reason: s.stopReason,
          winner: s.winner,
          calls,
        });
        return { status: s.status, winner: s.winner, calls };
      }
      if (s.nextAction === 'wait') {
        await collab.wait(agent, state.revision, 1000);
        continue;
      }
      onEvent({ event: 'thinking', agent, round: s.round });
      calls++;
      // One model invocation per scheduled turn. A failed invocation is surfaced,
      // not silently retried into an unbounded token-spending loop.
      let body;
      try {
        body = await turn({
          root,
          agent,
          model,
          effort,
          state,
          timeoutMs: Math.max(1, Math.min(timeoutMs, Date.parse(s.deadlineAt) - Date.now())),
          logDir,
          signal,
        });
      } catch (error) {
        if (signal?.aborted) return { status: 'interrupted', calls };
        const current = await collab.status(agent);
        if (current.session.id === sessionId && current.session.status !== 'active')
          return { status: current.session.status, winner: current.session.winner, calls };
        throw error;
      }
      if (signal?.aborted) return { status: 'interrupted', calls };
      const current = await collab.status(agent);
      if (current.session.id !== sessionId)
        throw new Error('Active session changed; restart the worker for the new goal.');
      if (current.session.status !== 'active')
        return { status: current.session.status, winner: current.session.winner, calls };
      if ((current.session.contextVersion ?? 0) !== (s.contextVersion ?? 0))
        throw new Error(
          'Shared user context changed during this turn. Restart the worker to review it.',
        );
      let sent;
      try {
        sent = await collab.post(
          agent,
          { ...body, contextVersion: s.contextVersion ?? 0, clientMessageId: randomUUID() },
          { sessionId },
        );
      } catch (error) {
        const latest = await collab.status(agent);
        if (latest.session.id === sessionId && latest.session.status !== 'active')
          return { status: latest.session.status, winner: latest.session.winner, calls };
        throw error;
      }
      onEvent({
        event: 'sent',
        agent,
        kind: sent.message.kind,
        round: sent.message.round,
        id: sent.message.id,
        summary: sent.message.summary,
      });
    }
    return { status: 'interrupted', calls };
  } finally {
    await release();
  }
}
