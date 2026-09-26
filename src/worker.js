import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { Collaboration } from './core.js';
import {
  CODEX_TOOL_TIMEOUT_SECONDS,
  peerContract,
  researchContract,
  serverConfig,
} from './setup.js';
import { runProcess, DEFAULT_MODELS } from './native.js';

export const DEFAULT_TURN_TIMEOUT_MS = 900000;
const MAX_TURN_TIMEOUT_MS = 3600000;
// One corrective call when the protocol rejects a message. A rejected message
// would otherwise end the whole session and discard every earlier turn.
const MAX_REPAIRS_PER_TURN = 1;

// Claude's shell runs in its OS sandbox: writes stay in the project and temp
// directories and network access is denied, matching Codex workspace-write.
const CLAUDE_WORKER_SETTINGS = JSON.stringify({
  disableAllHooks: true,
  sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false },
});

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

function phaseGuide(session, maxRounds) {
  if (session.phase === 'independent')
    return 'This is the independent phase. Your peer cannot see your work and you cannot see theirs. Build and test your answer in a scratch copy outside the repository (for example under $TMPDIR), leave shared files unchanged, and return one proposal with the complete solution and the evidence you actually observed.';
  const last = session.round >= maxRounds;
  return `This is discussion round ${session.round} of ${maxRounds}${last ? ' (final round: accept a verified candidate or record the unresolved alternatives and what would settle them)' : ''}. Both independent proposals are now visible. Spend this turn on the most consequential open question: compare behavior, try to break the leading candidate, integrate into the shared files if that is your job, or verify and accept.`;
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
  rejection,
}) {
  const id = randomUUID();
  const schemaFile = path.join(logDir, `${id}.schema.json`),
    finalFile = path.join(logDir, `${id}.response.json`);
  await fs.writeFile(schemaFile, JSON.stringify(TURN_SCHEMA));
  const config = serverConfig(root, agent, { contract: false });
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
  const repair = rejection
    ? `\nYOUR PREVIOUS MESSAGE FOR THIS TURN WAS REJECTED\n${rejection}\nKeep the work you already did. Return a corrected message that satisfies the protocol; if the rule cannot be met yet, choose a message kind that can (for example evidence instead of accept).\n`
    : '';
  const prompt = `${peerContract}\n\n${research}\n\nWORKER TURN (replaces the contract's send and wait steps)
You are ${agent}. This process makes exactly one contribution and exits; the worker delivers it and wakes you when the next round is ready.
- ${phaseGuide(state.session, state.config.maxRounds)}
- The filtered session below is current as of this turn. Call collab_status only if you need a fresher view. Use collab_claim and collab_release around edits to shared files and collab_verify for configured checks.
- Do not call collab_post, collab_start, collab_stop, collab_wait, or the model-collab CLI. Do not read or edit anything under .collab/ except CONTEXT.md, RESEARCH.md, and BRIEF.md.
- Return the message as JSON matching the output schema, with null for unused optional strings. Omit clientMessageId, sessionId, and contextVersion; the worker binds them to this turn.
- No background agents or recursive CLI calls. Stay within the user's repository scope and its normal instructions.
${repair}
SHARED CONTEXT\n${context || '(none)'}\n\nFILTERED SESSION\n${JSON.stringify(state)}\n`;
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
          '-c',
          `mcp_servers.model_collab.tool_timeout_sec=${CODEX_TOOL_TIMEOUT_SECONDS}`,
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
          'Read,Glob,Grep,Edit,Write,Bash,mcp__model_collab__*',
          '--disable-slash-commands',
          '--no-session-persistence',
          '--no-chrome',
          '--settings',
          CLAUDE_WORKER_SETTINGS,
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
  timeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  turn = nativeTurn,
  onEvent = () => {},
  signal,
}) {
  if (!['codex', 'claude'].includes(agent)) throw new Error('Workers support codex and claude.');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TURN_TIMEOUT_MS)
    throw new Error(`Worker timeout must be 1–${MAX_TURN_TIMEOUT_MS} ms.`);
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
      // One model invocation per scheduled turn, plus at most one corrective call
      // when the protocol rejects the message. Transport failures are surfaced,
      // not retried into an unbounded token-spending loop.
      let rejection = null;
      for (let repairs = 0; ; repairs++) {
        calls++;
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
            rejection,
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
        if ((current.session.contextVersion ?? 0) !== (s.contextVersion ?? 0)) {
          // The user added a note mid-turn. Discard work prepared against the old
          // context; the next loop iteration takes a fresh turn with the note.
          onEvent({ event: 'discarded', agent, reason: 'context_changed' });
          break;
        }
        try {
          const sent = await collab.post(
            agent,
            { ...body, contextVersion: s.contextVersion ?? 0, clientMessageId: randomUUID() },
            { sessionId },
          );
          onEvent({
            event: 'sent',
            agent,
            kind: sent.message.kind,
            round: sent.message.round,
            id: sent.message.id,
            summary: sent.message.summary,
          });
          break;
        } catch (error) {
          const latest = await collab.status(agent);
          if (latest.session.id === sessionId && latest.session.status !== 'active')
            return { status: latest.session.status, winner: latest.session.winner, calls };
          if (latest.session.id !== sessionId || repairs >= MAX_REPAIRS_PER_TURN) throw error;
          rejection = error.message;
          onEvent({ event: 'rejected', agent, reason: rejection });
        }
      }
    }
    return { status: 'interrupted', calls };
  } finally {
    await release();
  }
}
