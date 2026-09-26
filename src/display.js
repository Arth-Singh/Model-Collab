const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export function renderStartup(result, goal) {
  if (result.status === 'paused') {
    return `Collaboration is paused.\nProject: ${result.root}\nRun model-collab resume when you are ready to continue.`;
  }
  if (result.ui === 'workers') {
    return [
      `Collaboration ${result.status}${result.reason ? `: ${result.reason}` : '.'}`,
      ...result.peers.map(
        (peer, index) => `${['codex', 'claude'][index]}: ${peer.calls} model calls`,
      ),
      renderApplied(result),
    ]
      .filter(Boolean)
      .join('\n');
  }
  return [
    result.reused ? 'Existing collaboration ready.' : 'Collaboration started.',
    `Project: ${result.root}`,
    `Goal: ${goal}`,
    '',
    `Open the session: model-collab attach --repo ${quote(result.root)}`,
    'Switch peer panes: Ctrl-b o. Open controls: Ctrl-b n. Detach: Ctrl-b d.',
  ].join('\n');
}

function renderApplied({ winner, applied }) {
  if (!winner)
    return 'No candidate was agreed. Review the alternatives with model-collab status --human.';
  if (applied?.error) return `Agreed on ${winner}, but it was not applied: ${applied.error}`;
  if (applied)
    return `Agreed on ${winner} and applied it to your working tree: ${applied.files.join(', ') || 'no file changes'}.`;
  return `Agreed on ${winner}.`;
}

export function renderStatus(state) {
  const session = state.session;
  if (!session) return 'No active goal. Start one with model-collab up "Your goal".';
  const lines = [
    `Goal: ${session.topic}`,
    `Status: ${session.status}`,
    `Round: ${session.round} of ${state.config.maxRounds}`,
  ];
  if (session.stopReason) lines.push(`Reason: ${session.stopReason}`);
  if (session.winner || session.status === 'converged') lines.push(renderApplied(session));
  const recent = session.messages.slice(-4);
  if (recent.length)
    lines.push(
      '',
      'Recent contributions:',
      ...recent.map((message) => `  ${message.agent}: ${message.summary}`),
    );
  return lines.join('\n');
}

export function renderWorkerEvent(event) {
  if (event.event === 'thinking') return `[${event.agent}] Working on round ${event.round}.`;
  if (event.event === 'sent' || event.event === 'message')
    return `[${event.agent}] ${event.kind}: ${event.summary}`;
  if (event.event === 'rejected')
    return `[${event.agent}] Message rejected; asking for one correction: ${event.reason}`;
  if (event.event === 'discarded')
    return `[${event.agent}] Discarded a turn prepared before your latest note.`;
  if (event.event === 'cancelled')
    return `[${event.agent}] Stopped its turn early; the session is ${event.reason}.`;
  return null;
}
