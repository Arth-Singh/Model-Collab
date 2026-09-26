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
import { runProcess, DEFAULT_EFFORT, DEFAULT_MODELS } from './native.js';

export const DEFAULT_TURN_TIMEOUT_MS = 900000;
const MAX_TURN_TIMEOUT_MS = 3600000;
// One corrective call when the protocol rejects a message. A rejected message
// would otherwise end the whole session and discard every earlier turn.
const MAX_REPAIRS_PER_TURN = 1;
const SESSION_POLL_MS = 1000;

// Claude's shell runs in its OS sandbox: writes stay in its workspace and temp
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
    repliesTo: { type: ['string', 'null'] },
    resolves: { type: 'array', items: string },
  },
  required: ['kind', 'summary', 'evidence', 'candidate', 'solution', 'repliesTo', 'resolves'],
};

function cleanMessage(value) {
  if (typeof value === 'string') value = JSON.parse(value);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Worker response must be a JSON message.');
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null));
}

function phaseGuide(session, maxRounds) {
  if (session.phase === 'independent')
    return "Independent phase. Your workspace is a private copy of the project; your peer works in its own and neither can see the other. Search the board for the goal's key terms, pin down the contract, write tests from the specification, implement, and run the tests in your workspace. Post findings a later session would need. Return a proposal: the tool snapshots every file you changed, so put your design decisions in `solution` and what you ran in `evidence`.";
  const last = session.round >= maxRounds;
  return `Cross-examination, round ${session.round} of ${maxRounds}${last ? ' (final round: accept a candidate you verified or settle what remains as a judgment call; leave alternatives unresolved only when every candidate has a demonstrated defect)' : ''}. Every current candidate and your peer's board posts from this goal are visible; read board.newForYou first. Read each candidate with collab_diff, get a runnable copy with collab_checkout, and run your tests against your peer's candidate and your peer's tests against yours. Then send one verdict: accept the correct candidate, challenge one with a failing input, or propose a revision from your workspace that fixes a demonstrated defect.`;
}

async function sharedContext(root) {
  const parts = await Promise.all(
    ['CONTEXT.md', 'RESEARCH.md', 'BRIEF.md', 'MEMORY.md'].map(async (name) => {
      const text = await fs.readFile(path.join(root, '.collab', name), 'utf8').catch((e) => {
        if (e.code === 'ENOENT') return '';
        throw e;
      });
      return text ? `${name}\n${text.slice(0, 16000)}` : '';
    }),
  );
  return parts.filter(Boolean).join('\n\n');
}

export async function nativeTurn({
  root,
  agent,
  state,
  timeoutMs,
  model,
  effort = DEFAULT_EFFORT,
  logDir,
  signal,
  rejection,
}) {
  const id = randomUUID();
  const workspace = state.session.workspace;
  if (!workspace) throw new Error(`No workspace for ${agent}; start the goal again.`);
  const schemaFile = path.join(logDir, `${id}.schema.json`),
    finalFile = path.join(logDir, `${id}.response.json`);
  await fs.writeFile(schemaFile, JSON.stringify(TURN_SCHEMA));
  const config = serverConfig(root, agent, { contract: false });
  config.args.push('--worker-tools');
  const context = await sharedContext(root);
  const research = state.config.preset === 'research' ? researchContract : '';
  const repair = rejection
    ? `\nYOUR PREVIOUS MESSAGE FOR THIS TURN WAS REJECTED\n${rejection}\nKeep the work you already did. Return a corrected message that satisfies the protocol; if the rule cannot be met yet, choose a message kind that can (for example evidence instead of accept).\n`
    : '';
  const prompt = `${peerContract}\n\n${research}\n\nWORKER TURN (replaces the contract's send and wait steps)
You are ${agent}. This process makes exactly one contribution and exits; the worker delivers it and wakes you when the next round is ready.
- Your workspace is ${workspace}. It is your current directory. Edit files only there.
- ${phaseGuide(state.session, state.config.maxRounds)}
- The filtered session below is current as of this turn. Use collab_status only if you need a fresher view, and collab_verify to run configured checks.
- Do not call collab_post, collab_start, collab_stop, collab_wait, or the model-collab CLI. Do not read or edit ${path.join(root, '.collab')} except CONTEXT.md, RESEARCH.md, BRIEF.md, MEMORY.md, history/ (earlier goals), and checkouts the tools create for you.
- Return the message as JSON matching the output schema, with null for unused optional strings. Omit clientMessageId, sessionId, and contextVersion; the worker binds them to this turn.
- No background agents or recursive CLI calls. Stay within the user's scope and the repository's normal instructions.
${repair}
SHARED CONTEXT\n${context || '(none)'}\n\nFILTERED SESSION\n${JSON.stringify(state)}\n`;
  const args =
    agent === 'codex'
      ? [
          'exec',
          '--ignore-user-config',
          // The user's execpolicy rules can allow commands such as curl or git push
          // to run outside the sandbox; an unattended peer must not inherit them.
          '--ignore-rules',
          '--ephemeral',
          '--skip-git-repo-check',
          '--sandbox',
          'workspace-write',
          '-c',
          'approval_policy="never"',
          '-c',
          `model_reasoning_effort=${JSON.stringify(effort)}`,
          // Claude's worker has no web tools and both shells are offline; keep peers equal.
          '-c',
          'web_search="disabled"',
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
          workspace,
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
    cwd: workspace,
    // Sandboxed agents cannot write Go's default cache under the home directory.
    // Snapshots never capture .gocache.
    env: { ...process.env, GOCACHE: path.join(workspace, '.gocache') },
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

/** Abort `controller` as soon as the session ends or is replaced. Returns a stop function. */
function watchSession(collab, agent, sessionId, controller) {
  let stopped = false;
  (async () => {
    while (!stopped && !controller.signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, SESSION_POLL_MS));
      if (stopped) return;
      const s = (await collab.status(agent).catch(() => null))?.session;
      if (s && (s.id !== sessionId || s.status !== 'active')) controller.abort();
    }
  })();
  return () => {
    stopped = true;
  };
}

/** The worker waits locally between turns, making no model calls while idle. */
export async function runWorker({
  root,
  agent,
  model,
  effort = DEFAULT_EFFORT,
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
  let calls = 0;
  const seen = new Set();
  const sameSession = (state) => {
    if (state.session?.id !== sessionId)
      throw new Error('Active session changed; restart the worker for the new goal.');
    return state.session;
  };
  try {
    while (!signal?.aborted) {
      const state = await collab.status(agent),
        s = sameSession(state);
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
          applied: s.applied,
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
        // A peer can end the session (for example by accepting) while this turn
        // runs; the turn is then cancelled instead of spending more tokens.
        const turnController = new AbortController();
        const stopWatching = watchSession(collab, agent, sessionId, turnController);
        const turnSignal = signal
          ? AbortSignal.any([signal, turnController.signal])
          : turnController.signal;
        let body, failure;
        try {
          body = await turn({
            root,
            agent,
            model,
            effort,
            state,
            timeoutMs: Math.max(1, Math.min(timeoutMs, Date.parse(s.deadlineAt) - Date.now())),
            logDir,
            signal: turnSignal,
            rejection,
          });
        } catch (error) {
          failure = error;
        } finally {
          stopWatching();
        }
        if (signal?.aborted) return { status: 'interrupted', calls };
        const latest = sameSession(await collab.status(agent));
        if (latest.status !== 'active') {
          if (turnController.signal.aborted)
            onEvent({ event: 'cancelled', agent, reason: latest.status });
          break;
        }
        if (failure) throw failure;
        if ((latest.contextVersion ?? 0) !== (s.contextVersion ?? 0)) {
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
          const after = sameSession(await collab.status(agent));
          if (after.status !== 'active') break;
          if (repairs >= MAX_REPAIRS_PER_TURN) throw error;
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
