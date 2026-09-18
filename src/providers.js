import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_MODELS = Object.freeze({ codex: 'gpt-6-astra', claude: 'claude-fable-5-1[1m]' });
export const RESPONSE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { solution: { type: 'string' }, summary: { type: 'string' } },
  required: ['solution', 'summary'],
};

/** Run without a shell. Bound output and terminate the whole POSIX process group. */
export function runProcess(command, args = [], options = {}) {
  const { cwd, input = '', timeoutMs = 60_000, deadlineMs = Date.now() + timeoutMs, maxOutputBytes = 1_000_000, env = process.env, signal, onLaunch } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(deadlineMs)) throw new Error('A finite positive timeout and deadline are required');
  const remaining = Math.min(timeoutMs, deadlineMs - Date.now());
  if (remaining <= 0 || signal?.aborted) return Promise.resolve({ code: null, signal: null, stdout: '', stderr: '', error: signal?.aborted ? 'aborted' : 'deadline_exceeded', wallMs: 0, launched: false });
  return new Promise(resolve => {
    const started = Date.now();
    let stdout = '', stderr = '', bytes = 0, failure = null, settled = false, killTimer, launched = false;
    const child = spawn(command, args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const kill = signal => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* Process already exited. */ }
    };
    const stop = reason => {
      if (failure) return;
      failure = reason;
      kill('SIGTERM');
      killTimer = setTimeout(() => {
        kill('SIGKILL'); child.stdout.destroy(); child.stderr.destroy();
        finish(null, 'SIGKILL');
      }, 500);
      killTimer.unref();
    };
    const timer = setTimeout(() => stop('timeout'), remaining);
    const abort = () => stop('aborted');
    signal?.addEventListener('abort', abort, { once: true });
    const finish = (code, exitSignal) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      // A child may exit while a spawned descendant remains alive.
      if (failure) kill('SIGKILL');
      resolve({ code, signal: exitSignal, stdout, stderr, error: failure, wallMs: Date.now() - started, launched });
    };
    const collect = name => chunk => {
      const available = Math.max(0, maxOutputBytes - bytes);
      bytes += chunk.length;
      const text = chunk.subarray(0, available).toString('utf8');
      if (name === 'stdout') stdout += text; else stderr += text;
      if (bytes > maxOutputBytes) stop('output_limit');
    };
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
    child.on('spawn', () => { launched = true; onLaunch?.(); });
    child.on('error', error => { failure = `spawn_error: ${error.message}`; finish(null, null); });
    child.on('close', finish);
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export function parseSolution(value) {
  if (typeof value === 'string') {
    const stripped = value.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
    value = JSON.parse(stripped);
  }
  if (!value || typeof value.solution !== 'string' || typeof value.summary !== 'string') throw new Error('Provider response must contain string solution and summary');
  if (value.solution.length > 100_000 || value.summary.length > 20_000) throw new Error('Provider response exceeds size limit');
  return { solution: value.solution, summary: value.summary };
}

function normalizeUsage(provider, raw) {
  if (!raw || !Number.isFinite(raw.input_tokens) || !Number.isFinite(raw.output_tokens)) return null;
  const cachedInput = provider === 'codex' ? (raw.cached_input_tokens ?? 0) : (raw.cache_read_input_tokens ?? 0);
  const cacheCreation = provider === 'claude' ? (raw.cache_creation_input_tokens ?? 0) : 0;
  const input = raw.input_tokens + (provider === 'claude' ? cachedInput + cacheCreation : 0);
  return { input, output: raw.output_tokens, cachedInput, cacheCreation, total: input + raw.output_tokens };
}

function mergeUsage(usages) {
  if (!usages.length) return null;
  return usages.reduce((sum, usage) => Object.fromEntries(Object.keys(sum).map(key => [key, sum[key] + usage[key]])), { input: 0, output: 0, cachedInput: 0, cacheCreation: 0, total: 0 });
}

/** Real CLI adapter. It never receives task tests or repository paths. */
export async function callProvider({ provider, prompt, model = DEFAULT_MODELS[provider], effort = 'xhigh', timeoutMs = 60_000, deadlineMs = Date.now() + timeoutMs, commands = {}, signal, onLaunch }) {
  if (!['codex', 'claude'].includes(provider)) throw new Error(`Unknown provider: ${provider}`);
  const directory = await mkdtemp(join(tmpdir(), 'model-collab-eval-'));
  let processResult;
  try {
    const schemaPath = join(directory, 'response.schema.json');
    const finalPath = join(directory, 'response.json');
    await writeFile(schemaPath, JSON.stringify(RESPONSE_SCHEMA));
    const args = provider === 'codex' ? [
      'exec', '--ignore-user-config', '--skip-git-repo-check', '--ephemeral',
      '--sandbox', 'read-only', '--disable', 'shell_tool', '--disable', 'unified_exec',
      '--disable', 'multi_agent', '--disable', 'apps', '--disable', 'plugins',
      '--disable', 'hooks', '--disable', 'computer_use', '--disable', 'browser_use',
      '--disable', 'image_generation', '--disable', 'in_app_browser', '--disable', 'skill_search',
      '--config', 'web_search="disabled"', '--config', 'approval_policy="never"',
      '--config', `model_reasoning_effort="${effort}"`,
      '--model', model, '--cd', directory, '--output-schema', schemaPath,
      '--output-last-message', finalPath, '--json', '-',
    ] : [
      '-p', '--output-format', 'json', '--model', model, '--effort', effort,
      '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--disable-slash-commands', '--no-session-persistence', '--no-chrome',
      '--safe-mode', '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
      '--json-schema', JSON.stringify(RESPONSE_SCHEMA),
    ];
    processResult = await runProcess(commands[provider] ?? provider, args, {
      cwd: directory, input: prompt, timeoutMs, deadlineMs, signal, onLaunch,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    const raw = { stdout: processResult.stdout, stderr: processResult.stderr, exitCode: processResult.code, signal: processResult.signal };
    if (processResult.error || processResult.code !== 0) return { error: processResult.error ?? `exit_${processResult.code}`, raw, usage: null, launched: processResult.launched };
    if (provider === 'codex') {
      const events = processResult.stdout.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      const messages = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message');
      let response;
      try { response = await readFile(finalPath, 'utf8'); } catch { response = messages.at(-1)?.item?.text; }
      const usages = events.filter(event => event.type === 'turn.completed').map(event => normalizeUsage(provider, event.usage)).filter(Boolean);
      const observedModelIds = [...new Set(events.flatMap(event => [event.model, event.model_id, event.response?.model]).filter(value => typeof value === 'string'))];
      return { ...parseSolution(response), usage: mergeUsage(usages), raw, model, requestedEffort: effort, observedModelIds, observedEffort: null, launched: processResult.launched };
    }
    const parsed = JSON.parse(processResult.stdout);
    if (parsed.is_error) return { error: parsed.result ?? parsed.subtype ?? 'provider_error', raw, usage: normalizeUsage(provider, parsed.usage), launched: processResult.launched };
    return {
      ...parseSolution(parsed.structured_output ?? parsed.result),
      usage: normalizeUsage(provider, parsed.usage), raw, model, requestedEffort: effort, observedModelIds: [...new Set([...Object.keys(parsed.modelUsage ?? {}), parsed.model].filter(value => typeof value === 'string'))], observedEffort: null, launched: processResult.launched,
      reportedCostUsd: Number.isFinite(parsed.total_cost_usd) ? parsed.total_cost_usd : null,
    };
  } catch (error) {
    return { error: String(error.message), usage: null, raw: processResult ? { stdout: processResult.stdout, stderr: processResult.stderr } : null, launched: processResult?.launched ?? false };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
