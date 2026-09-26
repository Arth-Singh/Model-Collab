import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { configSchema, messageSchema, startSchema } from './schema.js';
import { runCommand } from './process.js';
import {
  applyCandidate,
  candidateDiff,
  captureBase,
  createWorkspace,
  materialize,
  removeWorkspace,
  repoInfo,
  snapshotWorkspace,
} from './workspace.js';

const STATE_VERSION = 2;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const fail = (message) => {
  throw new Error(message);
};
const active = (s) => s?.status === 'active';
const open = (s) => active(s) || s?.status === 'paused';
const current = (m, s) => (m.contextVersion ?? 0) === (s.contextVersion ?? 0);

async function atomicWrite(file, content) {
  const temp = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temp, file);
  } finally {
    await handle?.close();
    await fs.rm(temp, { force: true });
  }
}

export class Collaboration {
  constructor(root) {
    this.root = path.resolve(root);
    this.dir = path.join(this.root, '.collab');
    this.file = path.join(this.dir, 'state.json');
  }

  candidateFiles(id) {
    return path.join(this.dir, 'candidates', id, 'files');
  }

  async locked(fn) {
    await fs.mkdir(this.dir, { recursive: true });
    // The lock lives inside .collab so sandboxed agents granted only that
    // directory can still run the CLI.
    const release = await lockfile.lock(path.join(this.dir, 'state'), {
      realpath: false,
      retries: { retries: 25, minTimeout: 10, maxTimeout: 100 },
      stale: 10000,
    });
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  async init(options = {}) {
    const config = configSchema.parse({ participants: ['codex', 'claude'], ...options });
    return this.locked(async () => {
      try {
        await fs.access(this.file);
        return fail('Already initialized. Existing configuration was preserved.');
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      const state = { schemaVersion: STATE_VERSION, revision: 0, config, session: null };
      await atomicWrite(this.file, JSON.stringify(state, null, 2) + '\n');
      await this.publishViews(state);
      return state;
    });
  }

  // Version 1 sessions edited one shared tree and cannot continue in worktrees.
  migrate(state) {
    if (state.schemaVersion === STATE_VERSION) return;
    if (state.schemaVersion !== 1) fail('Unsupported state version.');
    state.schemaVersion = STATE_VERSION;
    const s = state.session;
    if (!s) return;
    delete s.claims;
    s.candidates = s.candidates.map(({ files, ...candidate }) => ({ ...candidate, changes: [] }));
    if (open(s))
      this.stopSession(s, 'stopped', 'Model Collab was upgraded; start this goal again.');
  }

  async transaction(fn) {
    return this.locked(async () => {
      let state;
      try {
        state = JSON.parse(await fs.readFile(this.file, 'utf8'));
      } catch (e) {
        if (e.code === 'ENOENT') fail('Run model-collab init first.');
        throw e;
      }
      const before = JSON.stringify(state);
      const wasOpen = open(state.session);
      this.migrate(state);
      this.expire(state);
      let result, error;
      try {
        result = await fn(state);
      } catch (e) {
        error = e;
      }
      // Persist expiry even if the attempted action is now rejected. Other rejected
      // mutations must validate fully before modifying state.
      if (JSON.stringify(state) !== before) {
        state.revision++;
        await atomicWrite(this.file, JSON.stringify(state, null, 2) + '\n');
        await this.publishViews(state);
      }
      // Review checkouts are full project copies; drop them once the session ends.
      if (wasOpen && !open(state.session))
        await fs.rm(path.join(this.dir, 'review'), { recursive: true, force: true });
      if (error) throw error;
      return structuredClone(result);
    });
  }

  expire(state) {
    const s = state.session;
    if (active(s) && Date.now() >= Date.parse(s.deadlineAt))
      this.stopSession(s, 'exhausted', 'deadline');
  }

  stopSession(s, status, reason) {
    s.status = status;
    s.stopReason = reason;
    s.endedAt = now();
  }
  requireAgent(state, agent) {
    if (!state.config.participants.includes(agent)) fail(`Unknown participant: ${agent}`);
  }
  requireActive(state) {
    if (!active(state.session))
      fail(
        `Session is ${state.session?.status ?? 'not started'}; start a new session to continue.`,
      );
    return state.session;
  }

  async removeWorkspaces() {
    const work = path.join(this.dir, 'work');
    const names = await fs.readdir(work).catch((e) => {
      if (e.code === 'ENOENT') return [];
      throw e;
    });
    if (!names.length) return;
    const { top } = await repoInfo(this.root);
    for (const name of names) await removeWorkspace(top, path.join(work, name));
  }

  async start(input) {
    const parsed = startSchema.parse(input);
    return this.transaction(async (state) => {
      if (open(state.session))
        fail('A session is already active or paused. Stop it before starting another.');
      // Projects initialized before dependencyDirs existed keep the default.
      const dependencyDirs = configSchema.parse(state.config).dependencyDirs;
      const base = await captureBase(this.root, path.join(this.dir, 'tmp'), dependencyDirs);
      if (state.session) {
        await fs.mkdir(path.join(this.dir, 'history'), { recursive: true });
        await atomicWrite(
          path.join(this.dir, 'history', `${state.session.id}.json`),
          JSON.stringify(state.session, null, 2) + '\n',
        );
      }
      await this.removeWorkspaces();
      for (const name of ['candidates', 'review', 'checkouts'])
        await fs.rm(path.join(this.dir, name), { recursive: true, force: true });
      const workspaces = {};
      try {
        for (const agent of state.config.participants)
          workspaces[agent] = await createWorkspace(base, path.join(this.dir, 'work', agent));
      } catch (error) {
        await this.removeWorkspaces().catch(() => {});
        throw error;
      }
      state.session = {
        id: randomUUID(),
        ...parsed,
        createdAt: now(),
        deadlineAt: new Date(Date.now() + state.config.deadlineMinutes * 60000).toISOString(),
        status: 'active',
        phase: 'independent',
        round: 0,
        contextVersion: 0,
        base,
        workspaces,
        humanNotes: [],
        messages: [],
        candidates: [],
        votes: {},
        challenges: [],
        checks: [],
        winner: null,
        applied: null,
      };
      return state;
    });
  }

  async status(agent) {
    return this.transaction((state) => {
      if (agent) this.requireAgent(state, agent);
      const view = structuredClone(state),
        s = view.session;
      if (!s) return view;
      s.roundsRemaining = Math.max(0, state.config.maxRounds - s.round);
      if (agent) {
        // Replay hashes are internal bookkeeping; peers only need the content.
        s.messages = s.messages.map(({ fingerprint, semantic, ...message }) => message);
        s.workspace = s.workspaces?.[agent];
        delete s.workspaces;
        delete s.base;
      }
      if (agent && s.phase === 'independent' && open(s)) {
        s.messages = s.messages.filter((m) => m.agent === agent);
        s.candidates = s.candidates.filter((c) => c.agent === agent);
        s.independentPeersPending = state.config.participants.filter(
          (p) => !state.session.messages.some((m) => m.agent === p && current(m, s)),
        );
      }
      s.nextAction = !active(s)
        ? 'stop'
        : s.messages.some((m) => m.agent === agent && m.round === s.round && current(m, s))
          ? 'wait'
          : s.phase === 'independent'
            ? 'solve independently in your workspace, then propose'
            : 'cross-examine the candidates, then send one message';
      return view;
    });
  }

  async configure(changes = {}) {
    const allowed = new Set([
      'preset',
      'maxRounds',
      'maxMessages',
      'deadlineMinutes',
      'checkTimeoutSeconds',
      'dependencyDirs',
      'checks',
    ]);
    if (Object.keys(changes).some((key) => !allowed.has(key))) fail('Unsupported project setting.');
    return this.transaction((state) => {
      if (open(state.session))
        fail('Stop the current collaboration before changing project settings.');
      state.config = configSchema.parse({ ...state.config, ...changes });
      return state;
    });
  }

  // During the independent phase a peer may only inspect its own candidates.
  visibleCandidate(state, agent, candidateId) {
    this.requireAgent(state, agent);
    const s = state.session;
    if (!s) fail('No session. Start a goal first.');
    const candidate = s.candidates.find((c) => c.id === candidateId);
    if (!candidate || (s.phase === 'independent' && open(s) && candidate.agent !== agent))
      fail('Unknown candidate.');
    return candidate;
  }

  converged(state, candidateId) {
    const s = state.session;
    const candidate = s.candidates.find((c) => c.id === candidateId);
    if (!candidate || candidate.supersededBy) return false;
    if (!state.config.participants.every((p) => s.votes[p] === candidateId)) return false;
    if (s.challenges.some((c) => c.candidate === candidateId && !c.resolvedBy)) return false;
    return Object.keys(state.config.checks).every((name) =>
      s.checks.some((c) => c.candidate === candidateId && c.name === name && c.passed),
    );
  }

  async applyWinner(s, candidateId) {
    const candidate = s.candidates.find((c) => c.id === candidateId);
    try {
      const files = await applyCandidate(s.base, candidate, this.candidateFiles(candidate.id));
      s.applied = { candidate: candidate.id, files, timestamp: now() };
    } catch (error) {
      s.applied = { candidate: candidate.id, error: error.message, timestamp: now() };
    }
    // Keep every attempt; `applied` is the latest.
    s.applyLog = [...(s.applyLog ?? []), s.applied];
  }

  async post(agent, input, { sessionId } = {}) {
    const body = messageSchema.parse(input);
    const fingerprint = hash(JSON.stringify(body));
    return this.transaction(async (state) => {
      this.requireAgent(state, agent);
      const s = state.session;
      if (sessionId && s?.id !== sessionId)
        fail('Active session changed; this contribution belongs to a previous goal.');
      const prior = s?.messages.find(
        (m) => m.agent === agent && m.clientMessageId === body.clientMessageId,
      );
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          fail('clientMessageId already used for different content.');
        return { message: prior, status: s.status, duplicate: true };
      }
      this.requireActive(state);
      if ((body.contextVersion ?? 0) !== (s.contextVersion ?? 0))
        fail(
          'Shared context changed. Read status and acknowledge its contextVersion before contributing.',
        );
      if (s.messages.some((m) => m.agent === agent && m.round === s.round && current(m, s)))
        fail('You already contributed this round. Wait for your peer.');
      if (s.phase === 'independent' && !['proposal', 'blocked'].includes(body.kind))
        fail('First submit an independent proposal.');
      if (body.kind !== 'blocked' && !body.evidence.length)
        fail(
          'Provide evidence: a concrete reason, test result, file reference, or counterexample.',
        );
      if (body.kind === 'proposal' && body.candidate)
        fail('A proposal creates its own candidate ID; omit candidate.');
      if (body.kind !== 'proposal' && body.solution !== undefined)
        fail('Only proposals carry a solution.');
      const candidate = body.candidate && s.candidates.find((c) => c.id === body.candidate);
      if (body.candidate && !candidate) fail('Unknown candidate.');
      if (['accept', 'challenge'].includes(body.kind) && !candidate)
        fail('This message requires a candidate ID.');
      if (candidate?.supersededBy)
        fail(`Candidate ${candidate.id} was superseded by ${candidate.supersededBy}.`);
      if (body.repliesTo && !s.messages.some((m) => m.id === body.repliesTo))
        fail('Unknown repliesTo message.');
      const resolving = body.resolves.map((id) => {
        const challenge = s.challenges.find((c) => c.id === id && !c.resolvedBy);
        if (!challenge || challenge.agent !== agent)
          fail('Only the original challenger can close an open challenge.');
        return challenge;
      });
      if (s.phase === 'independent' && (body.repliesTo || body.resolves.length))
        fail('Independent proposals cannot reference peers.');
      if (body.kind === 'accept') {
        const blocking = s.challenges.filter(
          (c) => c.candidate === candidate.id && !c.resolvedBy && !body.resolves.includes(c.id),
        );
        if (blocking.length)
          fail(
            `Resolve open challenges before accepting this candidate: ${blocking.map((c) => c.id).join(', ')}.`,
          );
        const missing = Object.keys(state.config.checks).filter(
          (name) =>
            !s.checks.some((c) => c.candidate === candidate.id && c.name === name && c.passed),
        );
        if (missing.length)
          fail(
            `Required checks have not passed on ${candidate.id}: ${missing.join(', ')}. Run collab_verify first.`,
          );
      }
      const id = `m${s.messages.length + 1}`;
      let changes = [];
      const pending = path.join(this.dir, 'candidates', `.pending-${randomUUID()}`);
      try {
        if (body.kind === 'proposal') {
          const workspace = path.join(this.dir, 'work', agent);
          changes = await snapshotWorkspace(s.base, workspace, pending);
          if (!changes.length && !body.solution?.trim())
            fail(
              'A proposal needs changed files in your workspace or a written solution. Your workspace has no changes.',
            );
        }
        const semantic = hash(JSON.stringify({ ...body, clientMessageId: undefined, changes }));
        if (
          body.kind !== 'accept' &&
          s.messages.some((m) => m.agent === agent && m.semantic === semantic)
        )
          fail('Repeated contribution adds no new evidence. Wait or provide a new check.');
        if (body.kind === 'proposal') {
          await fs.mkdir(path.dirname(this.candidateFiles(id)), { recursive: true });
          await fs.rm(this.candidateFiles(id), { recursive: true, force: true });
          await fs.mkdir(pending, { recursive: true });
          await fs.rename(pending, this.candidateFiles(id));
        }
        const message = {
          ...body,
          id,
          agent,
          contextVersion: s.contextVersion ?? 0,
          round: s.round,
          timestamp: now(),
          fingerprint,
          semantic,
        };
        if (body.kind === 'proposal') {
          for (const old of s.candidates.filter((c) => c.agent === agent && !c.supersededBy)) {
            old.supersededBy = id;
            for (const [peer, vote] of Object.entries(s.votes))
              if (vote === old.id) delete s.votes[peer];
          }
          s.candidates.push({
            id,
            agent,
            summary: body.summary,
            solution: body.solution ?? '',
            changes,
            createdAt: message.timestamp,
          });
          // Proposing is endorsing: the author's vote goes to its own candidate.
          s.votes[agent] = id;
        } else if (body.kind === 'challenge') {
          s.challenges.push({
            id,
            agent,
            candidate: candidate.id,
            summary: body.summary,
            resolvedBy: null,
          });
        } else if (body.kind === 'accept') {
          s.votes[agent] = candidate.id;
        }
        for (const challenge of resolving) challenge.resolvedBy = id;
        s.messages.push(message);
        const agreed = s.candidates.find((c) => !c.supersededBy && this.converged(state, c.id));
        if (body.kind === 'blocked') this.stopSession(s, 'blocked', body.summary);
        else if (agreed) {
          s.winner = agreed.id;
          this.stopSession(s, 'converged', 'unanimous_acceptance');
          await this.applyWinner(s, agreed.id);
        } else if (s.messages.length >= state.config.maxMessages)
          this.stopSession(s, 'exhausted', 'message_limit');
        else if (
          state.config.participants.every((p) =>
            s.messages.some((m) => m.agent === p && m.round === s.round && current(m, s)),
          )
        ) {
          if (s.round >= state.config.maxRounds) this.stopSession(s, 'exhausted', 'round_limit');
          else {
            s.round++;
            s.phase = 'discussion';
          }
        }
        return {
          message,
          status: s.status,
          round: s.round,
          winner: s.winner,
          applied: s.applied,
          duplicate: false,
        };
      } finally {
        await fs.rm(pending, { recursive: true, force: true });
      }
    });
  }

  async apply(candidateId) {
    return this.transaction(async (state) => {
      const s = state.session;
      if (!s) fail('No session to apply.');
      if (open(s)) fail('Stop the collaboration before applying a candidate yourself.');
      const id = candidateId ?? s.winner;
      if (!id) fail('No agreed candidate. Pass --candidate to apply one of the alternatives.');
      if (!s.candidates.some((c) => c.id === id)) fail('Unknown candidate.');
      await this.applyWinner(s, id);
      if (s.applied.error) fail(s.applied.error);
      return s.applied;
    });
  }

  async stop(reason = 'Stopped by user') {
    return this.transaction((state) => {
      if (!open(state.session)) fail('No active or paused session to stop.');
      this.stopSession(state.session, 'stopped', reason);
      return state;
    });
  }

  async pause() {
    return this.transaction((state) => {
      const s = this.requireActive(state);
      s.status = 'paused';
      s.pausedAt = now();
      return state;
    });
  }

  async resume() {
    return this.transaction((state) => {
      const s = state.session;
      if (s?.status !== 'paused') fail('Session is not paused.');
      s.deadlineAt = new Date(
        Date.parse(s.deadlineAt) + Date.now() - Date.parse(s.pausedAt),
      ).toISOString();
      s.status = 'active';
      delete s.pausedAt;
      return state;
    });
  }

  async note(text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 4000)
      fail('A user note must contain 1–4000 characters.');
    return this.transaction((state) => {
      const s = state.session;
      if (!open(s)) fail('Notes require an active or paused session.');
      if ((s.humanNotes?.length ?? 0) >= 20)
        fail('User-note limit reached. Start a fresh goal for more context.');
      s.contextVersion = (s.contextVersion ?? 0) + 1;
      s.humanNotes ??= [];
      s.humanNotes.push({ text: text.trim(), timestamp: now(), contextVersion: s.contextVersion });
      s.votes = {};
      s.checks = [];
      return state;
    });
  }

  /** A runnable copy of a candidate for review: the base plus the candidate's changes. */
  async checkout(agent, candidateId) {
    const { base, candidate } = await this.transaction((state) => ({
      base: state.session?.base,
      candidate: this.visibleCandidate(state, agent, candidateId),
    }));
    const dir = path.join(this.dir, 'review', agent, candidate.id);
    const cwd = await materialize(base, candidate, this.candidateFiles(candidate.id), dir);
    return { candidate: candidate.id, path: cwd, changes: candidate.changes };
  }

  async diff(agent, candidateId) {
    const { base, candidate } = await this.transaction((state) => ({
      base: state.session?.base,
      candidate: this.visibleCandidate(state, agent, candidateId),
    }));
    const scratch = path.join(this.dir, 'tmp', `diff-${randomUUID()}`);
    const text = await candidateDiff(base, candidate, this.candidateFiles(candidate.id), scratch);
    return {
      candidate: candidate.id,
      diff: text.length > 200000 ? text.slice(0, 200000) + '\n[diff truncated]\n' : text,
    };
  }

  async verify(agent, candidateId, name) {
    const captured = await this.transaction(async (state) => {
      const s = this.requireActive(state);
      const candidate = this.visibleCandidate(state, agent, candidateId);
      if (!Object.hasOwn(state.config.checks, name))
        fail('Unknown check. Checks must be configured by the user at initialization.');
      return {
        session: s.id,
        contextVersion: s.contextVersion ?? 0,
        base: s.base,
        candidate,
        argv: state.config.checks[name],
        // Projects initialized before checkTimeoutSeconds existed keep the default.
        timeoutMs: (state.config.checkTimeoutSeconds ?? 300) * 1000,
        deadline: s.deadlineAt,
      };
    });
    const dir = path.join(this.dir, 'checkouts', `${candidateId}-${randomUUID()}`);
    let result;
    try {
      const cwd = await materialize(
        captured.base,
        captured.candidate,
        this.candidateFiles(captured.candidate.id),
        dir,
      );
      result = await runCommand(captured.argv, {
        cwd,
        timeoutMs: Math.max(
          1,
          Math.min(captured.timeoutMs, Date.parse(captured.deadline) - Date.now()),
        ),
        maxBytes: 12000,
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
    return this.transaction(async (state) => {
      const s = this.requireActive(state);
      if (s.id !== captured.session) fail('Session changed while check was running.');
      if ((s.contextVersion ?? 0) !== captured.contextVersion)
        fail('Shared context changed while check was running. Run the check again.');
      const record = {
        candidate: candidateId,
        name,
        agent,
        timestamp: now(),
        passed: result.code === 0 && !result.error,
        code: result.code,
        error: result.error,
        durationMs: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
        outputTruncated: result.truncated,
      };
      s.checks = s.checks.filter((c) => !(c.candidate === candidateId && c.name === name));
      s.checks.push(record);
      return record;
    });
  }

  async wait(agent, afterRevision = -1, timeoutMs = 25000) {
    if (
      !Number.isInteger(afterRevision) ||
      afterRevision < -1 ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs < 0 ||
      timeoutMs > 25000
    )
      fail('Wait must use revision >= -1 and timeout 0–25000 ms.');
    const until = Date.now() + timeoutMs;
    do {
      const state = await this.status(agent);
      if (state.revision > afterRevision || !active(state.session) || Date.now() >= until)
        return state;
      await new Promise((resolve) => setTimeout(resolve, Math.min(200, until - Date.now())));
    } while (true);
  }

  async awaitTurn(agent, timeoutMs = 300000, signal) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 300000)
      fail('Turn wait must be 0–300000 ms.');
    const until = Date.now() + timeoutMs;
    do {
      const state = await this.status(agent);
      if (state.session?.nextAction !== 'wait' || signal?.aborted || Date.now() >= until)
        return state;
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, until - Date.now())));
    } while (true);
  }

  async transcript(format = 'jsonl') {
    const state = await this.status();
    return this.renderTranscript(state, format);
  }

  renderTranscript(state, format = 'jsonl') {
    const s = state.session;
    if (!s)
      return format === 'jsonl'
        ? ''
        : '# Model Collab\n\nNo active goal. Start one with `model-collab start`.\n';
    if (format === 'jsonl') return s.messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
    const changed = (id) => {
      const candidate = s.candidates.find((c) => c.id === id);
      return candidate?.changes?.length
        ? `\nChanged files: ${candidate.changes.map((c) => `\`${c.path}\` (${c.status})`).join(', ')}.\n`
        : '';
    };
    const applied = s.applied
      ? s.applied.error
        ? `Applying ${s.applied.candidate} failed: ${s.applied.error}\n\n`
        : `Applied ${s.applied.candidate} to the working tree: ${s.applied.files.join(', ') || 'no file changes'}.\n\n`
      : '';
    return (
      `# Collaboration: ${s.topic}\n\nStatus: **${s.status}**. Reason: ${s.stopReason ?? 'in progress'}. Round: ${s.round}. Revision: ${state.revision}.${s.winner ? ` Agreed candidate: ${s.winner}.` : ''}\n\n${applied}This README is a generated transcript. Send messages through MCP or the CLI; do not edit this file. Canonical JSON: state.json. Message stream: messages.jsonl. Shared context: CONTEXT.md.\n\n` +
      (s.humanNotes ?? [])
        .map((n) => `## User note · context ${n.contextVersion}\n\n${n.text}\n\n`)
        .join('') +
      s.messages
        .map(
          (m) =>
            `## ${m.id} · ${m.agent} · ${m.kind} · round ${m.round}\n\n${m.summary}\n${m.candidate ? `\nCandidate: ${m.candidate}.\n` : ''}${m.kind === 'proposal' ? changed(m.id) : ''}\n${m.evidence.map((e) => `- ${e}`).join('\n')}\n${m.solution ? `\n\`\`\`text\n${m.solution}\n\`\`\`\n` : ''}`,
        )
        .join('\n')
    );
  }

  async publishViews(state) {
    await atomicWrite(path.join(this.dir, 'README.md'), this.renderTranscript(state, 'markdown'));
    await atomicWrite(path.join(this.dir, 'messages.jsonl'), this.renderTranscript(state, 'jsonl'));
  }

  async refreshViews() {
    return this.transaction(async (state) => {
      await this.publishViews(state);
      return { refreshed: true, revision: state.revision };
    });
  }
}
