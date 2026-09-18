import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { configSchema, messageSchema, startSchema } from './schema.js';
import { runCommand } from './process.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const fail = message => { throw new Error(message); };
const active = s => s?.status === 'active';

async function atomicWrite(file, content) {
  const temp = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    await handle.writeFile(content); await handle.sync(); await handle.close(); handle = null;
    await fs.rename(temp, file);
  } finally { await handle?.close(); await fs.rm(temp, { force: true }); }
}

export class Collaboration {
  constructor(root) {
    this.root = path.resolve(root);
    this.dir = path.join(this.root, '.collab');
    this.file = path.join(this.dir, 'state.json');
  }

  async locked(fn) {
    await fs.mkdir(this.dir, { recursive: true });
    const release = await lockfile.lock(this.dir, { realpath: false, retries: { retries: 25, minTimeout: 10, maxTimeout: 100 }, stale: 10000 });
    try { return await fn(); } finally { await release(); }
  }

  async init(options = {}) {
    const config = configSchema.parse({ participants: ['codex', 'claude'], ...options });
    return this.locked(async () => {
      try { await fs.access(this.file); return fail('Already initialized. Existing configuration was preserved.'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      const state = { schemaVersion: 1, revision: 0, config, session: null };
      await atomicWrite(this.file, JSON.stringify(state, null, 2) + '\n');
      await this.publishViews(state);
      return state;
    });
  }

  async transaction(fn) {
    return this.locked(async () => {
      let state;
      try { state = JSON.parse(await fs.readFile(this.file, 'utf8')); }
      catch (e) { if (e.code === 'ENOENT') fail('Run model-collab init first.'); throw e; }
      if (state.schemaVersion !== 1) fail('Unsupported state version.');
      const before = JSON.stringify(state);
      this.expire(state);
      let result, error;
      try { result = await fn(state); } catch (e) { error = e; }
      // Persist expiry even if the attempted action is now rejected. Other rejected
      // mutations must validate fully before modifying state.
      if (JSON.stringify(state) !== before) {
        state.revision++;
        await atomicWrite(this.file, JSON.stringify(state, null, 2) + '\n');
        await this.publishViews(state);
      }
      if (error) throw error;
      return structuredClone(result);
    });
  }

  expire(state) {
    const s = state.session;
    if (active(s) && Date.now() >= Date.parse(s.deadlineAt)) this.stopSession(s, 'exhausted', 'deadline');
    if (s) s.claims = s.claims.filter(c => c.expiresAt > Date.now());
  }

  stopSession(s, status, reason) { s.status = status; s.stopReason = reason; s.endedAt = now(); s.claims = []; }
  requireAgent(state, agent) { if (!state.config.participants.includes(agent)) fail(`Unknown participant: ${agent}`); }
  requireActive(state) { if (!active(state.session)) fail(`Session is ${state.session?.status ?? 'not started'}; start a new session to continue.`); return state.session; }

  async start(input) {
    const parsed = startSchema.parse(input);
    return this.transaction(async state => {
      if (active(state.session) || state.session?.status === 'paused') fail('A session is already active or paused. Stop it before starting another.');
      if (state.session) {
        await fs.mkdir(path.join(this.dir, 'history'), { recursive: true });
        await atomicWrite(path.join(this.dir, 'history', `${state.session.id}.json`), JSON.stringify(state.session, null, 2) + '\n');
      }
      state.session = {
        id: randomUUID(), ...parsed, createdAt: now(), deadlineAt: new Date(Date.now() + state.config.deadlineMinutes * 60000).toISOString(),
        status: 'active', phase: 'independent', round: 0, contextVersion: 0, humanNotes: [], messages: [], candidates: [], votes: {}, challenges: [], checks: [], claims: [], winner: null,
      };
      return state;
    });
  }

  async status(agent) {
    return this.transaction(state => {
      if (agent) this.requireAgent(state, agent);
      const view = structuredClone(state), s = view.session;
      if (!s) return view;
      if (agent && s.phase === 'independent' && (active(s) || s.status === 'paused')) {
        s.messages = s.messages.filter(m => m.agent === agent);
        s.candidates = s.candidates.filter(c => c.agent === agent);
        s.independentPeersPending = state.config.participants.filter(p => !state.session.messages.some(m => m.agent === p && (m.contextVersion ?? 0) === (s.contextVersion ?? 0)));
      }
      s.nextAction = !active(s) ? 'stop' : s.messages.some(m => m.agent === agent && m.round === s.round && (m.contextVersion ?? 0) === (s.contextVersion ?? 0)) ? 'wait' : s.phase === 'independent' ? 'propose independently' : 'contribute one evidence-led message';
      return view;
    });
  }

  async safePath(relative, allowMissing = false) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..') || relative.includes('\\')) fail('Paths must be relative and stay inside the repository.');
    const normalized = path.normalize(relative);
    if (normalized === '.' || normalized.startsWith('.collab') || normalized.split('/').includes('.git')) fail('Cannot claim or snapshot collaboration state or Git metadata.');
    const root = await fs.realpath(this.root);
    const full = path.join(root, normalized);
    let cursor = full, canonical;
    while (true) {
      try {
        const resolved = await fs.realpath(cursor);
        if (resolved !== root && !resolved.startsWith(root + path.sep)) fail('Symlink escapes repository.');
        canonical = path.join(resolved, path.relative(cursor, full));
        break;
      } catch (e) {
        if (!allowMissing || e.code !== 'ENOENT' || cursor === root) throw e;
        cursor = path.dirname(cursor);
      }
    }
    const canonicalRelative = path.relative(root, canonical);
    if (!canonicalRelative || canonicalRelative === '.collab' || canonicalRelative.startsWith('.collab/') || canonicalRelative.split('/').includes('.git')) fail('Cannot claim or snapshot the root, collaboration state, or Git metadata.');
    return { full: canonical, relative: canonicalRelative };
  }

  async snapshot(files) {
    const result = [];
    for (const file of [...new Set(files)].sort()) {
      const p = await this.safePath(file);
      const info = await fs.stat(p.full);
      if (!info.isFile() || info.size > 10 * 1024 * 1024) fail(`Not a regular file under 10 MiB: ${file}`);
      result.push({ path: p.relative, sha256: hash(await fs.readFile(p.full)) });
    }
    return [...new Map(result.map(item => [item.path, item])).values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  async assertFresh(candidate) {
    if (candidate.supersededBy) fail(`Candidate superseded by ${candidate.supersededBy}.`);
    const current = await this.snapshot(candidate.files.map(f => f.path));
    if (JSON.stringify(current) !== JSON.stringify(candidate.files)) fail('Candidate files changed. Publish a new proposal before accepting or verifying.');
  }

  async post(agent, input, { sessionId } = {}) {
    const body = messageSchema.parse(input);
    const fingerprint = hash(JSON.stringify(body));
    return this.transaction(async state => {
      this.requireAgent(state, agent);
      const s = state.session;
      if (sessionId && s?.id !== sessionId) fail('Active session changed; this contribution belongs to a previous goal.');
      const prior = s?.messages.find(m => m.agent === agent && m.clientMessageId === body.clientMessageId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) fail('clientMessageId already used for different content.');
        return { message: prior, status: s.status, duplicate: true };
      }
      this.requireActive(state);
      if ((body.contextVersion ?? 0) !== (s.contextVersion ?? 0)) fail('Shared context changed. Read status and acknowledge its contextVersion before contributing.');
      if (s.messages.some(m => m.agent === agent && m.round === s.round && (m.contextVersion ?? 0) === (s.contextVersion ?? 0))) fail('You already contributed this round. Wait for peers; do not ping-pong.');
      if (s.phase === 'independent' && !['proposal', 'blocked'].includes(body.kind)) fail('First submit an independent proposal.');
      if (body.kind !== 'blocked' && !body.evidence.length) fail('Provide evidence: a concrete reason, test result, file reference, or counterexample.');
      if (body.kind === 'proposal' && body.candidate) fail('A proposal creates its own candidate ID; omit candidate.');
      if (body.kind !== 'proposal' && (body.solution !== undefined || body.files.length)) fail('Only proposals carry a solution or files.');
      const candidate = body.candidate && s.candidates.find(c => c.id === body.candidate);
      if (body.candidate && !candidate) fail('Unknown candidate.');
      if (['accept', 'challenge'].includes(body.kind) && !candidate) fail('This message requires a candidate ID.');
      if (body.repliesTo && !s.messages.some(m => m.id === body.repliesTo)) fail('Unknown repliesTo message.');
      const resolving = body.resolves.map(id => {
        const challenge = s.challenges.find(c => c.id === id && !c.resolvedBy);
        if (!challenge || challenge.agent !== agent) fail('Only the original challenger can close an open challenge.');
        return challenge;
      });
      if (s.phase === 'independent' && (body.repliesTo || body.resolves.length)) fail('Independent proposals cannot reference peers.');
      if (candidate) await this.assertFresh(candidate);
      if (body.kind === 'accept') {
        const open = s.challenges.filter(c => c.candidate === candidate.id && !c.resolvedBy && !body.resolves.includes(c.id));
        if (open.length) fail('Resolve open challenges before accepting this candidate.');
        const missing = Object.keys(state.config.checks).filter(name => !s.checks.some(c => c.candidate === candidate.id && c.name === name && c.passed));
        if (missing.length) fail(`Required checks have not passed: ${missing.join(', ')}`);
      }
      const files = body.kind === 'proposal' ? await this.snapshot(body.files) : [];
      const semantic = hash(JSON.stringify({ ...body, clientMessageId: undefined, files }));
      if (body.kind !== 'accept' && s.messages.some(m => m.agent === agent && m.semantic === semantic)) fail('Repeated contribution adds no new evidence. Wait or provide a new check.');
      if (body.kind === 'accept' && s.votes[agent] === candidate.id) fail('You already accepted this candidate. Wait for peers.');
      const id = `m${s.messages.length + 1}`;
      const message = { ...body, id, agent, contextVersion: s.contextVersion ?? 0, round: s.round, timestamp: now(), fingerprint, semantic };
      if (body.kind === 'proposal') {
        for (const old of s.candidates.filter(c => c.agent === agent && !c.supersededBy)) old.supersededBy = id;
        s.candidates.push({ id, agent, summary: body.summary, solution: body.solution ?? '', files, createdAt: message.timestamp });
        s.votes = {};
      } else if (body.kind === 'challenge') {
        s.challenges.push({ id, agent, candidate: candidate.id, summary: body.summary, resolvedBy: null });
        s.votes = {};
      } else if (body.kind === 'accept') {
        s.votes[agent] = candidate.id;
      } else {
        delete s.votes[agent];
      }
      for (const challenge of resolving) challenge.resolvedBy = id;
      s.messages.push(message);
      if (body.kind === 'blocked') this.stopSession(s, 'blocked', body.summary);
      else if (state.config.participants.every(p => s.votes[p] && s.votes[p] === s.votes[agent])) {
        s.winner = s.votes[agent];
        this.stopSession(s, 'converged', 'unanimous_acceptance');
      } else if (s.messages.length >= state.config.maxMessages) this.stopSession(s, 'exhausted', 'message_limit');
      else if (state.config.participants.every(p => s.messages.some(m => m.agent === p && m.round === s.round && (m.contextVersion ?? 0) === (s.contextVersion ?? 0)))) {
        if (s.round >= state.config.maxRounds) this.stopSession(s, 'exhausted', 'round_limit');
        else { s.round++; s.phase = 'discussion'; }
      }
      return { message, status: s.status, round: s.round, winner: s.winner, duplicate: false };
    });
  }

  async stop(reason = 'Stopped by user') {
    return this.transaction(state => {
      if (!active(state.session) && state.session?.status !== 'paused') fail('No active or paused session to stop.');
      this.stopSession(state.session, 'stopped', reason); return state;
    });
  }

  async pause() {
    return this.transaction(state => {
      const s = this.requireActive(state);
      s.status = 'paused'; s.pausedAt = now(); s.claims = [];
      return state;
    });
  }

  async resume() {
    return this.transaction(state => {
      const s = state.session;
      if (s?.status !== 'paused') fail('Session is not paused.');
      s.deadlineAt = new Date(Date.parse(s.deadlineAt) + Date.now() - Date.parse(s.pausedAt)).toISOString();
      s.status = 'active'; delete s.pausedAt;
      return state;
    });
  }

  async note(text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 4000) fail('A user note must contain 1–4000 characters.');
    return this.transaction(state => {
      const s = state.session;
      if (!active(s) && s?.status !== 'paused') fail('Notes require an active or paused session.');
      if ((s.humanNotes?.length ?? 0) >= 20) fail('User-note limit reached. Start a fresh goal for more context.');
      s.contextVersion = (s.contextVersion ?? 0) + 1;
      s.humanNotes ??= [];
      s.humanNotes.push({ text: text.trim(), timestamp: now(), contextVersion: s.contextVersion });
      s.votes = {}; s.checks = [];
      return state;
    });
  }

  async claim(agent, files, leaseSeconds = 300) {
    if (!Array.isArray(files) || !files.length || files.length > 50 || !Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 1800) fail('Claim 1–50 file paths for 1–1800 seconds.');
    const paths = await Promise.all(files.map(f => this.safePath(f, true).then(p => p.relative)));
    return this.transaction(state => {
      this.requireAgent(state, agent); const s = this.requireActive(state);
      const overlaps = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
      const conflict = s.claims.find(c => c.agent !== agent && paths.some(p => overlaps(c.path, p)));
      if (conflict) fail(`${conflict.path} is claimed by ${conflict.agent}.`);
      const expiresAt = Date.now() + leaseSeconds * 1000;
      for (const file of new Set(paths)) {
        s.claims = s.claims.filter(c => !(c.agent === agent && c.path === file));
        s.claims.push({ agent, path: file, expiresAt });
      }
      return s.claims.filter(c => c.agent === agent);
    });
  }

  async release(agent, files = []) {
    const canonical = await Promise.all(files.map(f => this.safePath(f, true).then(p => p.relative)));
    return this.transaction(state => {
      this.requireAgent(state, agent);
      if (state.session) state.session.claims = state.session.claims.filter(c => c.agent !== agent || (canonical.length && !canonical.includes(c.path)));
      return { released: true };
    });
  }

  async verify(agent, candidateId, name) {
    const captured = await this.transaction(async state => {
      this.requireAgent(state, agent); const s = this.requireActive(state);
      const candidate = s.candidates.find(c => c.id === candidateId);
      if (!candidate) fail('Unknown candidate.');
      if (!Object.hasOwn(state.config.checks, name)) fail('Unknown check. Checks must be configured by the user at initialization.');
      const argv = state.config.checks[name];
      if (!candidate.files.length) fail('Verification requires a file-backed proposal. Include all relevant source and test files.');
      await this.assertFresh(candidate);
      return { session: s.id, contextVersion: s.contextVersion ?? 0, candidate, argv, deadline: s.deadlineAt };
    });
    const result = await runCommand(captured.argv, { cwd: this.root, timeoutMs: Math.max(1, Math.min(60000, Date.parse(captured.deadline) - Date.now())) });
    return this.transaction(async state => {
      const s = this.requireActive(state);
      if (s.id !== captured.session) fail('Session changed while check was running.');
      if ((s.contextVersion ?? 0) !== captured.contextVersion) fail('Shared context changed while check was running. Run the check again.');
      const candidate = s.candidates.find(c => c.id === candidateId);
      await this.assertFresh(candidate);
      const record = { candidate: candidateId, name, agent, timestamp: now(), passed: result.code === 0 && !result.error, ...result, stdout: result.stdout.slice(-12000), stderr: result.stderr.slice(-12000), outputTruncated: result.stdout.length > 12000 || result.stderr.length > 12000 };
      s.checks = s.checks.filter(c => !(c.candidate === candidateId && c.name === name));
      s.checks.push(record);
      return record;
    });
  }

  async wait(agent, afterRevision = -1, timeoutMs = 25000) {
    if (!Number.isInteger(afterRevision) || afterRevision < -1 || !Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 25000) fail('Wait must use revision >= -1 and timeout 0–25000 ms.');
    const until = Date.now() + timeoutMs;
    do {
      const state = await this.status(agent);
      if (state.revision > afterRevision || !active(state.session) || Date.now() >= until) return state;
      await new Promise(resolve => setTimeout(resolve, Math.min(200, until - Date.now())));
    } while (true);
  }

  async awaitTurn(agent, timeoutMs = 300000, signal) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 300000) fail('Turn wait must be 0–300000 ms.');
    const until = Date.now() + timeoutMs;
    do {
      const state = await this.status(agent);
      if (state.session?.nextAction !== 'wait' || signal?.aborted || Date.now() >= until) return state;
      await new Promise(resolve => setTimeout(resolve, Math.min(250, until - Date.now())));
    } while (true);
  }

  async transcript(format = 'jsonl') {
    const state = await this.status();
    return this.renderTranscript(state, format);
  }

  renderTranscript(state, format = 'jsonl') {
    const s = state.session;
    if (!s) return format === 'jsonl' ? '' : '# Model Collab\n\nNo active goal. Start one with `model-collab start`.\n';
    if (format === 'jsonl') return s.messages.map(m => JSON.stringify(m)).join('\n') + '\n';
    return `# Collaboration: ${s.topic}\n\nStatus: **${s.status}**. Reason: ${s.stopReason ?? 'in progress'}. Round: ${s.round}. Revision: ${state.revision}.\n\nThis README is a generated transcript. Send messages through MCP or the CLI; do not edit this file. Canonical JSON: state.json. Message stream: messages.jsonl. Shared context: CONTEXT.md.\n\n` + (s.humanNotes ?? []).map(n => `## User note · context ${n.contextVersion}\n\n${n.text}\n\n`).join('') + s.messages.map(m => `## ${m.id} · ${m.agent} · ${m.kind} · round ${m.round}\n\n${m.summary}\n${m.candidate ? `\nCandidate: ${m.candidate}.\n` : ''}\n${m.evidence.map(e => `- ${e}`).join('\n')}\n${m.solution ? `\n\`\`\`text\n${m.solution}\n\`\`\`\n` : ''}`).join('\n');
  }

  async publishViews(state) {
    await atomicWrite(path.join(this.dir, 'README.md'), this.renderTranscript(state, 'markdown'));
    await atomicWrite(path.join(this.dir, 'messages.jsonl'), this.renderTranscript(state, 'jsonl'));
  }

  async refreshViews() {
    return this.transaction(async state => { await this.publishViews(state); return { refreshed: true, revision: state.revision }; });
  }
}
