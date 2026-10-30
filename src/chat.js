import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runCommand } from './process.js';

// The swarm talks over SwarmChat (github.com/Pranjal2041/swarmchat): one local
// server per project, one user and token per agent, and the `swarmchat` CLI as
// the only client. Agents never run the CLI themselves. Both agent sandboxes
// block localhost, so the Model Collab MCP server, which runs outside the
// sandbox, makes each call with the calling agent's token.

export const GENERAL = 'general';
export const HUMAN = 'user';
export const SYSTEM = 'model-collab';
export const INSTALL_HINT = 'Install SwarmChat with: uv tool install swarmchat==0.1.0';

const EXIT_WAIT_TIMED_OUT = 4;
const EXIT_NOT_FOUND = 2;
const CLI_OUTPUT_BYTES = 8_000_000;

const fail = (message) => {
  throw new Error(message);
};

const parseLines = (text) =>
  text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

/** Run one `swarmchat --json` command. Exit codes other than 0 are returned, not thrown. */
async function cli(command, args, { env = {}, input, timeoutMs = 30_000, signal } = {}) {
  const result = await runCommand([command, '--json', ...args], {
    timeoutMs,
    maxBytes: CLI_OUTPUT_BYTES,
    input,
    env: { ...process.env, ...env },
    signal,
  });
  if (result.error === 'aborted') return result;
  if (result.error === 'timeout') fail(`swarmchat ${args[0]} did not answer in time.`);
  if (result.error) fail(`Could not run ${command}: ${result.error}. ${INSTALL_HINT}`);
  if (result.truncated) fail(`swarmchat ${args[0]} printed more than the client can read.`);
  return result;
}

function checked(result, args) {
  if (result.code === 0) return parseLines(result.stdout);
  fail(`swarmchat ${args[0]}: ${result.stderr.trim() || `exit ${result.code}`}`);
}

/**
 * Start a server on a free localhost port. The data folder keeps every chat,
 * so a project's history carries over from one run to the next.
 */
export async function startServer({ command = 'swarmchat', dataDir, timeoutMs = 20_000 }) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const child = spawn(command, ['serve', '--data', dataDir, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => settle(new Error(`SwarmChat did not start within ${timeoutMs} ms. ${stderr.trim()}`)),
      timeoutMs,
    );
    function settle(error, value) {
      clearTimeout(timer);
      child.off('exit', onExit);
      if (error) {
        child.kill('SIGKILL');
        reject(error);
      } else resolve(value);
    }
    const onExit = (code) => settle(new Error(`SwarmChat exited (${code}): ${stderr.trim()}`));
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = stdout.match(/serving (https?:\/\/\S+)/);
      if (match) settle(null, match[1]);
    });
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => settle(new Error(`Could not start ${command}: ${error.message}`)));
    child.on('exit', onExit);
  });
  // Keep draining output so a chatty server never blocks on a full pipe.
  child.stdout.resume();
  child.stderr.resume();
  const exited = new Promise((resolve) => child.once('exit', resolve));
  return {
    url,
    pid: child.pid,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
    },
  };
}

/** Stop a server left behind by a run whose supervisor died, if that PID is still SwarmChat. */
export async function stopStaleServer(pid) {
  if (!pid) return false;
  const ps = await runCommand(['ps', '-p', String(pid), '-o', 'command='], { timeoutMs: 5000 });
  if (ps.code !== 0 || !/swarmchat\b.*\bserve\b/.test(ps.stdout)) return false;
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

/**
 * Create each user, or give an existing one a new token. Tokens are printed
 * only once, so every run rotates them instead of storing them across runs.
 */
export async function provisionUsers({ command = 'swarmchat', dataDir, ids }) {
  const tokens = {};
  for (const id of ids) {
    const add = await cli(command, ['admin', '--data', dataDir, 'add', id, '--name', id]);
    if (add.code === 0) {
      tokens[id] = parseLines(add.stdout)[0].token;
      continue;
    }
    if (!/already exists/.test(add.stderr))
      fail(`Could not add chat user ${id}: ${add.stderr.trim()}`);
    const args = ['admin', '--data', dataDir, 'rotate', id];
    tokens[id] = checked(await cli(command, args), args)[0].token;
  }
  return tokens;
}

/** A SwarmChat client acting as one user. */
export class ChatClient {
  constructor({ command = 'swarmchat', url, token }) {
    if (!url || !token) fail('A chat client needs the server URL and a token.');
    this.command = command;
    this.env = { SWARMCHAT_SERVER: url, SWARMCHAT_TOKEN: token };
  }

  async run(args, options = {}) {
    return cli(this.command, args, { env: this.env, ...options });
  }

  async call(args, options) {
    return checked(await this.run(args, options), args);
  }

  /** Unread messages across all chats by default, oldest first; marks what it returns read. */
  async read({ chat, thread, last, all, from, mentions, search, before, limit = 50, peek } = {}) {
    const args = ['read', ...(chat ? [chat] : [])];
    if (thread) args.push('--thread', thread);
    if (before) args.push('--before', before);
    if (last) args.push('--last', String(last));
    if (all) args.push('--all');
    if (from) args.push('--from', from);
    if (mentions) args.push('--mentions');
    if (search) args.push('--search', search);
    if (peek) args.push('--peek');
    args.push('--limit', String(limit));
    return this.call(args);
  }

  /** Send to a channel (`#name`), a person, or people separated by commas. */
  async send(to, text, { replyTo } = {}) {
    const body = text.trim();
    if (!body) fail('A message needs text.');
    const args = ['send', to, '-', ...(replyTo ? ['--reply-to', replyTo] : [])];
    return (await this.call(args, { input: body }))[0];
  }

  /** Block until something new arrives. Returns [] when the wait times out or `signal` aborts. */
  async wait({ timeoutSeconds = 60, chat, from, mentions, peek, signal } = {}) {
    const args = ['wait', '--timeout', String(timeoutSeconds)];
    if (chat) args.push('--chat', chat);
    if (from) args.push('--from', from);
    if (mentions) args.push('--mentions');
    if (peek) args.push('--peek');
    const result = await this.run(args, { timeoutMs: (timeoutSeconds + 30) * 1000, signal });
    if (result.code === EXIT_WAIT_TIMED_OUT || result.error === 'aborted') return [];
    return checked(result, args);
  }

  async chats({ unread, limit = 50 } = {}) {
    return this.call(['chats', ...(unread ? ['--unread'] : []), '--limit', String(limit)]);
  }

  /** A chat's details, or null when there is no such chat. */
  async info(chat) {
    const result = await this.run(['info', chat]);
    if (result.code === EXIT_NOT_FOUND) return null;
    return checked(result, ['info'])[0];
  }

  async channel(action, ...args) {
    return this.call(['channel', action, ...args]);
  }
}

/** Make sure a public channel exists and every listed user is in it. */
export async function ensureChannel(client, name, members, description) {
  const existing = await client.info(name);
  if (!existing) {
    await client.channel(
      'create',
      name,
      '--public',
      '--members',
      members.join(','),
      ...(description ? ['--description', description] : []),
    );
    return;
  }
  const present = new Set(existing.members.map((m) => m.id));
  const missing = members.filter((id) => !present.has(id));
  if (missing.length) await client.channel('add', name, ...missing);
}

/**
 * Every message in the data folder sent between `since` and `until`, oldest
 * first, read straight from SwarmChat's plain-text logs (no server needed).
 */
export async function readTranscript(dataDir, { since, until } = {}) {
  const chatsDir = path.join(dataDir, 'chats');
  const messages = [];
  for (const id of await fs.readdir(chatsDir).catch(() => [])) {
    const meta = JSON.parse(await fs.readFile(path.join(chatsDir, id, 'meta.json'), 'utf8'));
    const title = meta.name ? `#${meta.name}` : meta.members.join(',');
    const logDir = path.join(chatsDir, id, 'log');
    for (const file of (await fs.readdir(logDir).catch(() => [])).sort()) {
      for (const line of parseLines(await fs.readFile(path.join(logDir, file), 'utf8'))) {
        if (line.kind !== 'message' || !line.text) continue;
        if ((since && line.at < since) || (until && line.at > until)) continue;
        messages.push({
          id: `${id}:${line.seq}`,
          chat: title,
          from: line.from,
          at: line.at,
          text: line.text,
          ...(line.reply_to ? { replyTo: line.reply_to } : {}),
        });
      }
    }
  }
  return messages.sort((a, b) => a.at.localeCompare(b.at));
}
