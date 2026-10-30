import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_EFFORT, DEFAULT_MODELS, runProcess } from './process.js';

// One agent session: a headless Claude Code or Codex process that works in
// the agent's clone until it decides to stop, then returns { next, summary }.
// The supervisor starts a fresh session after each one, so context never
// grows without bound (the loop Carlini's 16-agent compiler used).

export const BACKENDS = ['claude', 'codex'];
export const CODEX_TOOL_TIMEOUT_SECONDS = 3600;
// Codex prints an event for every step it takes. A session silent this long
// with no command running has lost its model stream.
export const CODEX_IDLE_MS = 600_000;

const WORKER_TOOLS = 'Read,Glob,Grep,Edit,Write,Bash';
// Claude's shell runs in its OS sandbox: writes stay in the directories it is
// given and network access is denied, matching Codex workspace-write.
const CLAUDE_SETTINGS = JSON.stringify({
  disableAllHooks: true,
  sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false },
});

export const SESSION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    next: { type: 'string', enum: ['continue', 'wait'] },
    summary: { type: 'string' },
  },
  required: ['next', 'summary'],
};

// Agents get the environment a toolchain needs and nothing else: no API keys,
// tokens, or cloud credentials from the user's shell. A swarm shares what one
// agent finds, so one leaked secret reaches every agent.
const PASSED_ENV = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'TMPDIR',
  'TZ',
  'LANG',
  'COLORTERM',
  'NO_COLOR',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'GOPATH',
  'GOROOT',
  'GOFLAGS',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'RUSTUP_TOOLCHAIN',
  'JAVA_HOME',
  'PYENV_ROOT',
  'PYENV_VERSION',
  'VIRTUAL_ENV',
  'CONDA_PREFIX',
  'CONDA_DEFAULT_ENV',
  'CONDA_EXE',
  'NVM_DIR',
  'NVM_BIN',
  'PNPM_HOME',
  'BUN_INSTALL',
  'DENO_DIR',
  'HOMEBREW_PREFIX',
  'HOMEBREW_CELLAR',
  'HOMEBREW_REPOSITORY',
  'PKG_CONFIG_PATH',
  'CPATH',
  'LIBRARY_PATH',
  'CC',
  'CXX',
  'SDKROOT',
  'DEVELOPER_DIR',
  'MACOSX_DEPLOYMENT_TARGET',
]);
const PASSED_PREFIXES = ['LC_', 'XDG_'];

/** The environment for an agent process: an allowlist plus names the user chose to pass. */
export function agentEnv(source = process.env, passEnv = []) {
  const extra = new Set(passEnv);
  return Object.fromEntries(
    Object.entries(source).filter(
      ([name, value]) =>
        value !== undefined &&
        (PASSED_ENV.has(name) ||
          extra.has(name) ||
          PASSED_PREFIXES.some((prefix) => name.startsWith(prefix))),
    ),
  );
}

/** True while Codex runs a command or tool call it started and has not finished. */
export function codexBusy(log) {
  const open = new Set();
  for (const line of log.split('\n')) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'item.started') open.add(event.item?.id);
    else if (event.type === 'item.completed') open.delete(event.item?.id);
  }
  return open.size > 0;
}

/** Arguments for one headless session of `agent.backend`. */
export function sessionArgs({ agent, origin, mcp, schemaFile, finalFile }) {
  const model = agent.model ?? DEFAULT_MODELS[agent.backend];
  const effort = agent.effort ?? DEFAULT_EFFORT;
  if (agent.backend === 'codex')
    return [
      'exec',
      '--ignore-user-config',
      // The user's execpolicy rules can allow commands such as curl or git push
      // to run outside the sandbox; an unattended agent must not inherit them.
      '--ignore-rules',
      '--ephemeral',
      '--sandbox',
      'workspace-write',
      '--add-dir',
      agent.gitDir,
      '--add-dir',
      origin,
      '-c',
      'approval_policy="never"',
      '-c',
      `model_reasoning_effort=${JSON.stringify(effort)}`,
      '-c',
      'web_search="disabled"',
      '-c',
      `mcp_servers.model_collab.command=${JSON.stringify(mcp.command)}`,
      '-c',
      `mcp_servers.model_collab.args=${JSON.stringify(mcp.args)}`,
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
      model,
      '--cd',
      agent.workspace,
      '--output-schema',
      schemaFile,
      '--output-last-message',
      finalFile,
      '--json',
      '-',
    ];
  return [
    '-p',
    '--model',
    model,
    '--effort',
    effort,
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(SESSION_SCHEMA),
    '--strict-mcp-config',
    '--mcp-config',
    JSON.stringify({ mcpServers: { model_collab: mcp } }),
    '--permission-mode',
    'acceptEdits',
    '--permission-prompts',
    'none',
    // Only these built-in tools exist in the session. Allow rules in the user's
    // settings, such as WebFetch for github.com, cannot bring back a web tool.
    '--tools',
    WORKER_TOOLS,
    '--allowedTools',
    `${WORKER_TOOLS},mcp__model_collab__*`,
    '--add-dir',
    agent.gitDir,
    '--add-dir',
    origin,
    '--disable-slash-commands',
    '--no-session-persistence',
    '--no-chrome',
    '--settings',
    CLAUDE_SETTINGS,
  ];
}

const RATE_LIMITED =
  /usage limit|rate limit|rate_limit|too many requests|\b429\b|quota|limit reached|overloaded/i;

/** Usage and failure text from a finished process, whatever the backend printed. */
export function readOutput(backend, stdout) {
  if (backend === 'claude') {
    let response;
    try {
      response = JSON.parse(stdout);
    } catch {
      return { usage: null, error: null, response: null };
    }
    const u = response.usage ?? {};
    return {
      response,
      error: response.is_error ? String(response.result ?? response.subtype ?? 'error') : null,
      usage: {
        inputTokens:
          (u.input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0),
        cachedInputTokens: u.cache_read_input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        costUsd: response.total_cost_usd ?? null,
      },
    };
  }
  const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: null };
  const errors = [];
  for (const line of stdout.split('\n')) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'turn.completed') {
      usage.inputTokens += event.usage?.input_tokens ?? 0;
      usage.cachedInputTokens += event.usage?.cached_input_tokens ?? 0;
      usage.outputTokens += event.usage?.output_tokens ?? 0;
    } else if (event.type === 'turn.failed') errors.push(event.error?.message ?? 'turn failed');
    else if (event.type === 'error') errors.push(event.message ?? 'error');
  }
  return { usage, error: errors.at(-1) ?? null, response: null };
}

function sessionResult(value) {
  if (typeof value === 'string') value = JSON.parse(value);
  if (!value || !['continue', 'wait'].includes(value.next) || typeof value.summary !== 'string')
    throw new Error('The session did not return { next, summary }.');
  return { next: value.next, summary: value.summary.trim().slice(0, 4000) };
}

/**
 * Run one session to completion. Failures are returned, not thrown, so the
 * supervisor can back off, retry, or retire the agent: `failure.kind` is
 * `rate_limited`, `timeout`, `aborted`, `stalled`, or `error`.
 */
export async function runSession({
  agent,
  origin,
  mcp,
  prompt,
  logDir,
  timeoutMs,
  deadlineMs,
  signal,
  env = process.env,
  passEnv = [],
  idleMs = CODEX_IDLE_MS,
  onLaunch,
  run = runProcess,
}) {
  await fs.mkdir(logDir, { recursive: true });
  const id = randomUUID();
  const schemaFile = path.join(logDir, `${id}.schema.json`),
    finalFile = path.join(logDir, `${id}.response.json`);
  await fs.writeFile(schemaFile, JSON.stringify(SESSION_SCHEMA));
  const args = sessionArgs({ agent, origin, mcp, schemaFile, finalFile });
  const codex = agent.backend === 'codex';
  const attempt = async (input, suffix) => {
    const result = await run(agent.backend, args, {
      cwd: agent.workspace,
      // Sandboxed agents cannot write Go's default cache under the home directory.
      env: { ...agentEnv(env, passEnv), GOCACHE: path.join(agent.workspace, '.gocache') },
      input,
      timeoutMs,
      deadlineMs,
      signal,
      onLaunch,
      // Codex returns its answer through --output-last-message; its --json event
      // stream is only a log and grows with every command it runs, so keep a tail.
      ...(codex
        ? {
            tailBytes: 1_000_000,
            maxOutputBytes: 256_000_000,
            idleMs,
            busy: codexBusy,
          }
        : { maxOutputBytes: 4_000_000 }),
    });
    await fs.writeFile(
      path.join(logDir, `${id}${suffix}.log.json`),
      JSON.stringify({ agent: agent.id, backend: agent.backend, model: agent.model, ...result }),
    );
    return result;
  };
  let result = await attempt(prompt, '');
  if (codex && result.error === 'stalled')
    result = await attempt(
      `${prompt}\nYOUR PREVIOUS SESSION STOPPED RESPONDING\nIts edits remain in your workspace. Check them with git status before relying on them, then continue.\n`,
      '-retry',
    );
  const output = readOutput(agent.backend, result.stdout);
  const base = { usage: output.usage, wallMs: result.wallMs };
  const failed = (kind, message) => ({ ...base, failure: { kind, message } });
  if (result.error === 'aborted') return failed('aborted', 'The run ended.');
  if (result.error === 'timeout' || result.error === 'deadline_exceeded')
    return failed('timeout', 'The session reached its time limit.');
  if (result.error === 'stalled') return failed('stalled', 'Codex stopped responding twice.');
  const problem =
    output.error ??
    (result.error || result.code !== 0
      ? result.stderr.trim().slice(-500) || result.error || `exit ${result.code}`
      : null) ??
    (!codex && !output.response ? 'Claude printed no result.' : null);
  if (problem) {
    const kind = RATE_LIMITED.test(`${problem}\n${result.stderr.slice(-2000)}`)
      ? 'rate_limited'
      : 'error';
    return failed(kind, String(problem).slice(-500));
  }
  try {
    const value = codex
      ? await fs.readFile(finalFile, 'utf8')
      : (output.response.structured_output ?? output.response.result);
    return { ...base, ...sessionResult(value) };
  } catch (error) {
    return failed('error', error.message);
  }
}
