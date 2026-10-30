// Terminal output for runs: one line per event while a run is supervised, and
// a summary for `model-collab status`.

const clock = () => new Date().toTimeString().slice(0, 8);
const oneLine = (text, max = 160) => {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const tokens = (usage) =>
  usage ? `${Math.round((usage.inputTokens + usage.outputTokens) / 1000)}k tokens` : '';

export function renderEvent(event) {
  const line = (text) => `${clock()} ${text}`;
  switch (event.event) {
    case 'started':
      return [
        line(`Run ${event.runId} started with ${event.agents.length} agents.`),
        `  ${event.agents.map((a) => a.id).join(', ')}`,
        `  Deadline ${event.deadlineAt}. Watch the chat: model-collab view`,
      ].join('\n');
    case 'session':
      return line(`${event.agent} starts session ${event.number}`);
    case 'ended':
      return line(
        `${event.agent} ${event.timedOut ? 'hit the session time limit' : `→ ${event.next}`} (${Math.round(event.wallMs / 1000)}s, ${tokens(event.usage)}): ${oneLine(event.summary)}`,
      );
    case 'woke':
      return line(`${event.agent} woke for a new message`);
    case 'failed':
      return line(
        `${event.agent} session failed (${event.kind}): ${oneLine(event.message, 200)}. Retrying in ${event.retryInSeconds}s.`,
      );
    case 'retired':
      return line(`${event.agent} retired: ${event.reason}`);
    case 'push':
      return line(`main ${event.commit.slice(0, 8)} ${event.author}: ${oneLine(event.subject)}`);
    case 'chat':
      return line(`#general ${event.from}: ${oneLine(event.text)}`);
    case 'checks':
      return line(
        `checks on ${event.commit.slice(0, 8)}: ${event.results.map((r) => `${r.name} ${r.passed ? 'passed' : 'failed'}`).join(', ') || 'none configured'}`,
      );
    case 'complete':
      return line(`Run ${event.status}: ${event.reason}`);
    case 'memory':
      return line(event.message);
    default:
      return null;
  }
}

export function renderResult(run) {
  const usage = run.agents.reduce(
    (sum, a) => ({
      tokens: sum.tokens + a.usage.inputTokens + a.usage.outputTokens,
      cost: sum.cost + (a.usage.costUsd ?? 0),
      sessions: sum.sessions + a.sessions,
    }),
    { tokens: 0, cost: 0, sessions: 0 },
  );
  const result = run.result;
  const lines = [
    `Run ${run.status}: ${run.stopReason ?? 'no reason recorded'}`,
    `${run.agents.length} agents, ${usage.sessions} sessions, ${Math.round(usage.tokens / 1000)}k tokens${usage.cost ? `, $${usage.cost.toFixed(2)} reported by Claude Code` : ''}.`,
  ];
  if (!result) return lines.join('\n');
  lines.push(
    `${result.commits} commits on the swarm's main; its history is in refs/model-collab/result.`,
  );
  if (result.applied)
    lines.push(`Applied to your working tree: ${result.applied.join(', ') || 'no file changes'}.`);
  else if (result.error) lines.push(`Not applied: ${result.error}`);
  else if (result.commits)
    lines.push(
      `Not applied, because the run ${run.status === 'finished' ? 'changed nothing' : `ended as ${run.status}`}. Review it with git diff HEAD refs/model-collab/result, then run model-collab apply to take it.`,
    );
  return lines.join('\n');
}

export function renderStatus(state) {
  const run = state.run;
  if (!run) return 'No run yet. Start one with model-collab up "Your goal".';
  const minutesLeft = Math.max(0, Math.round((Date.parse(run.deadlineAt) - Date.now()) / 60000));
  const lines = [
    `Run ${run.id}: ${run.status}${run.stopReason ? ` (${run.stopReason})` : ''}`,
    `Goal: ${oneLine(run.goal, 300)}`,
    ['starting', 'running'].includes(run.status)
      ? `Deadline ${run.deadlineAt}, about ${minutesLeft} minutes left.`
      : `Ended ${run.endedAt ?? 'unknown'}.`,
    '',
    ...run.agents.map(
      (a) =>
        `  ${a.id.padEnd(10)} ${a.state.padEnd(8)} ${String(a.sessions).padStart(3)} sessions  ${tokens(a.usage).padStart(12)}${a.rateLimited ? `  rate limited ${a.rateLimited}x` : ''}  ${oneLine(a.retiredReason ?? a.lastSummary ?? '', 90)}`,
    ),
  ];
  if (run.checkRounds.length) {
    const last = run.checkRounds.at(-1);
    lines.push(
      '',
      `Checks on ${last.commit.slice(0, 8)}: ${last.results.map((r) => `${r.name} ${r.passed ? 'passed' : 'failed'}`).join(', ')}`,
    );
  }
  if (run.result) lines.push('', renderResult(run));
  return lines.join('\n');
}
