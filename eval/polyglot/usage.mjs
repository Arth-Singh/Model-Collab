// Usage/cost parsers for agent CLI output. Missing fields become null (or 0 for summed token counts).
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function parseJsonLoose(text) {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {}
  const lines = trimmed.split('\n').reverse();
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {}
  }
  return null;
}

/** Parse `claude -p --output-format json` stdout (single result object, or a verbose event array). */
export function parseClaudeJson(stdout) {
  let data = parseJsonLoose(stdout);
  if (Array.isArray(data)) data = data.findLast((event) => event?.type === 'result') ?? null;
  if (!data || typeof data !== 'object') {
    return {
      ok: false,
      parseError: 'no JSON result object in stdout',
      costUsd: null,
      durationMs: null,
      durationApiMs: null,
      numTurns: null,
      isError: null,
      subtype: null,
      sessionId: null,
      result: null,
      usage: null,
      modelUsage: null,
    };
  }
  const u = data.usage ?? {};
  return {
    ok: true,
    costUsd: num(data.total_cost_usd ?? data.cost_usd),
    durationMs: num(data.duration_ms),
    durationApiMs: num(data.duration_api_ms),
    numTurns: num(data.num_turns),
    isError: typeof data.is_error === 'boolean' ? data.is_error : null,
    subtype: data.subtype ?? null,
    sessionId: data.session_id ?? null,
    result: typeof data.result === 'string' ? data.result : null,
    usage: {
      inputTokens: num(u.input_tokens),
      cacheCreationInputTokens: num(u.cache_creation_input_tokens),
      cacheReadInputTokens: num(u.cache_read_input_tokens),
      outputTokens: num(u.output_tokens),
    },
    modelUsage: data.modelUsage ?? null,
  };
}

/** Parse `codex exec --json` JSONL stdout; sums usage over all `turn.completed` events. */
export function parseCodexJsonl(stdout) {
  const summary = {
    threadId: null,
    turnsCompleted: 0,
    turnsFailed: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    errors: [],
    lastAgentMessage: null,
    events: 0,
    unparsedLines: 0,
  };
  for (const line of (stdout ?? '').split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      summary.unparsedLines++;
      continue;
    }
    if (!event || typeof event !== 'object') continue;
    summary.events++;
    if (event.type === 'thread.started') summary.threadId = event.thread_id ?? summary.threadId;
    else if (event.type === 'turn.completed') {
      summary.turnsCompleted++;
      const u = event.usage ?? {};
      summary.inputTokens += num(u.input_tokens) ?? 0;
      summary.cachedInputTokens += num(u.cached_input_tokens) ?? 0;
      summary.outputTokens += num(u.output_tokens) ?? 0;
      summary.reasoningOutputTokens += num(u.reasoning_output_tokens) ?? 0;
    } else if (event.type === 'turn.failed') {
      summary.turnsFailed++;
      summary.errors.push(event.error?.message ?? JSON.stringify(event.error ?? event));
    } else if (event.type === 'error') {
      summary.errors.push(event.message ?? JSON.stringify(event));
    } else if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      summary.lastAgentMessage = event.item.text ?? summary.lastAgentMessage;
    }
  }
  return summary;
}
