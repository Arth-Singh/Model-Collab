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
  if (state.board?.posts)
    lines.push(
      `Board: ${state.board.posts} post${state.board.posts === 1 ? '' : 's'} in ${state.board.channels.map((c) => c.name).join(', ')}`,
    );
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
  if (event.event === 'memory') {
    if (event.status === 'updating')
      return event.when === 'before'
        ? 'Updating project memory from the previous goal.'
        : 'Updating project memory from this goal.';
    if (event.status === 'failed')
      return `Project memory was not updated: ${event.error} Run model-collab memory update to retry.`;
    const skipped = event.skipped
      ? ` Skipped ${event.skipped} older goal(s); an update remembers at most three.`
      : '';
    return event.changed
      ? `Project memory updated: .collab/MEMORY.md.${skipped}`
      : `Project memory unchanged; nothing durable to add.${skipped}`;
  }
  if (event.event === 'cancelled')
    return `[${event.agent}] Stopped its turn early; the session is ${event.reason}.`;
  return null;
}

const postLine = (post) =>
  `${post.id} · #${post.channel} · ${post.author} · ${post.createdAt}${post.thread !== post.id ? ` · reply in ${post.thread}` : ''}\n  ${post.text.replaceAll('\n', '\n  ')}${post.truncated ? ' [...]' : ''}`;

export function renderBoardPosts({ results, hasMore, nextCursor }) {
  if (!results.length) return 'No posts.';
  return [
    ...results.map(postLine),
    ...(hasMore ? [`More results: --cursor ${nextCursor}`] : []),
  ].join('\n\n');
}

export function renderBoardThreads({ results, hasMore, nextCursor }) {
  if (!results.length) return 'No threads.';
  return [
    ...results.map(
      (t) =>
        `${postLine(t.root)}\n  ${t.replies} ${t.replies === 1 ? 'reply' : 'replies'}, last activity ${t.lastActivityAt}`,
    ),
    ...(hasMore ? [`More threads: --cursor ${nextCursor}`] : []),
  ].join('\n\n');
}
