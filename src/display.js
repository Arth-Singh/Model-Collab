const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export function renderStartup(result, goal) {
  if (result.status === 'paused') {
    return `Collaboration is paused.\nProject: ${result.root}\nRun model-collab resume when you are ready to continue.`;
  }
  if (result.ui === 'workers') {
    return [
      'Collaboration finished.',
      ...result.peers.map(
        (peer, index) => `${['codex', 'claude'][index]}: ${peer.status} (${peer.calls} calls)`,
      ),
    ].join('\n');
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

export function renderStatus(state) {
  const session = state.session;
  if (!session) return 'No active goal. Start one with model-collab up "Your goal".';
  const lines = [
    `Goal: ${session.topic}`,
    `Status: ${session.status}`,
    `Round: ${session.round} of ${state.config.maxRounds}`,
  ];
  if (session.stopReason) lines.push(`Reason: ${session.stopReason}`);
  if (session.winner) lines.push(`Accepted proposal: ${session.winner}`);
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
  if (event.event === 'complete')
    return `Session ${event.status}${event.reason ? `: ${event.reason}` : '.'}`;
  return null;
}
