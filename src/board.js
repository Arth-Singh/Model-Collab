import fs from 'node:fs/promises';
import path from 'node:path';

// A project-level message board: channels hold threads, a thread is its first
// post plus flat replies. Posts outlive goals, so findings carry over to later
// sessions. Modeled on the Codex agent message board (openai/codex
// ext/agent-message-board), adapted to peers that cannot be interrupted mid-turn:
// unread posts surface in status instead of being pushed.

export const PREVIEW_CHARS = 150;
export const POSTS_PER_GOAL = 12;
const RESPONSE_CHARS = 20000;

const fail = (message) => {
  throw new Error(message);
};

function clip(text, maxChars) {
  const chars = Array.from(text);
  return chars.length <= maxChars
    ? { text, chars: chars.length, truncated: false }
    : { text: chars.slice(0, maxChars).join(''), chars: chars.length, truncated: true };
}

export class BoardStore {
  constructor(dir) {
    this.file = path.join(dir, 'board.jsonl');
    this.cache = null;
  }

  async posts() {
    let stat;
    try {
      stat = await fs.stat(this.file);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const key = `${stat.size}:${stat.mtimeMs}`;
    if (this.cache?.key === key) return this.cache.posts;
    const posts = [];
    for (const line of (await fs.readFile(this.file, 'utf8')).split('\n')) {
      if (!line.trim()) continue;
      try {
        posts.push(JSON.parse(line));
      } catch {
        // A crash mid-append leaves a partial line that was never acknowledged
        // to its author; skip it rather than lose the board.
      }
    }
    this.cache = { key, posts };
    return posts;
  }

  /** Append one post. Callers hold the project lock. */
  async append(post) {
    const handle = await fs.open(this.file, 'a+', 0o600);
    try {
      const { size } = await handle.stat();
      let prefix = '';
      if (size) {
        const last = Buffer.alloc(1);
        await handle.read(last, 0, 1, size - 1);
        if (last[0] !== 0x0a) prefix = '\n';
      }
      await handle.appendFile(prefix + JSON.stringify(post) + '\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.cache = null;
  }
}

const sealing = (session) =>
  ['active', 'paused'].includes(session?.status) && session.phase === 'independent';

/**
 * Posts `viewer` may see. While a goal is in its independent phase, a peer's
 * posts from that goal stay sealed, like its candidate. The user (no viewer)
 * sees everything.
 */
export function visiblePosts(posts, session, viewer) {
  if (!viewer || !sealing(session)) return posts;
  return posts.filter(
    (p) => p.author === viewer || p.author === 'user' || p.sessionId !== session.id,
  );
}

function meta(post, session) {
  return {
    id: post.id,
    channel: post.channel,
    thread: post.thread,
    author: post.author,
    createdAt: post.createdAt,
    currentGoal: Boolean(post.sessionId) && post.sessionId === session?.id,
  };
}

export function previewOf(post, session, maxChars) {
  const { text, chars, truncated } = clip(post.text, maxChars);
  return { ...meta(post, session), text, chars, truncated };
}

// Pages stop early when the rendered results would exceed the response budget,
// so one call never floods the caller's context. The cursor is an offset.
function page(items, { limit, cursor }, render) {
  const start = Number(cursor ?? 0);
  const results = [];
  let used = 0,
    i = start;
  for (; i < items.length && results.length < limit; i++) {
    const view = render(items[i]);
    const size = JSON.stringify(view).length;
    if (results.length && used + size > RESPONSE_CHARS) break;
    results.push(view);
    used += size;
  }
  return { results, hasMore: i < items.length, nextCursor: i < items.length ? String(i) : null };
}

function threadIndex(posts) {
  const threads = new Map();
  for (const post of posts) {
    if (post.thread === post.id) threads.set(post.id, { root: post, replies: [] });
    else threads.get(post.thread)?.replies.push(post);
  }
  return [...threads.values()];
}

function threadSummary(thread, session, maxChars) {
  const latest = thread.replies.at(-1);
  return {
    thread: thread.root.id,
    channel: thread.root.channel,
    root: previewOf(thread.root, session, maxChars),
    replies: thread.replies.length,
    lastActivityAt: (latest ?? thread.root).createdAt,
    latestReply: latest ? previewOf(latest, session, maxChars) : null,
  };
}

/** Newest first. Every whitespace-separated query term must appear, ignoring case. */
export function searchPosts(posts, session, query) {
  const terms = (query.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const after = query.after && posts.find((p) => p.id === query.after);
  if (query.after && !after) fail(`Unknown post ${query.after}.`);
  const matches = posts
    .filter(
      (p) =>
        (!query.channel || p.channel === query.channel) &&
        (!query.author || p.author === query.author) &&
        (!after || p.seq > after.seq) &&
        terms.every((term) => p.text.toLowerCase().includes(term)),
    )
    .reverse();
  return page(matches, query, (p) => previewOf(p, session, query.maxChars));
}

export function listThreads(posts, session, query) {
  const lastSeq = (t) => (t.replies.at(-1) ?? t.root).seq;
  const threads = threadIndex(posts)
    .filter((t) => !query.channel || t.root.channel === query.channel)
    .sort((a, b) => (query.sort === 'created' ? b.root.seq - a.root.seq : lastSeq(b) - lastSeq(a)));
  return page(threads, query, (t) => threadSummary(t, session, query.maxChars));
}

/** A thread's first post and its replies, oldest first. */
export function readThread(posts, session, query) {
  const thread = threadIndex(posts).find((t) => t.root.id === query.thread);
  if (!thread) {
    const reply = posts.find((p) => p.id === query.thread);
    fail(
      reply
        ? `${reply.id} is a reply; read its thread ${reply.thread}.`
        : `Unknown thread ${query.thread}.`,
    );
  }
  return {
    thread: thread.root.id,
    channel: thread.root.channel,
    root: previewOf(thread.root, session, query.maxChars),
    replies: page(thread.replies, query, (p) => previewOf(p, session, query.maxChars)),
  };
}

/** Full text of one post, sliced by Unicode character offsets. */
export function readPost(posts, session, query) {
  const post = posts.find((p) => p.id === query.post);
  if (!post) fail(`Unknown post ${query.post}.`);
  const chars = Array.from(post.text);
  const end = Math.min(chars.length, query.offset + query.limit);
  return {
    ...meta(post, session),
    text: chars.slice(query.offset, end).join(''),
    chars: chars.length,
    nextOffset: end < chars.length ? end : null,
  };
}

/**
 * The board as it appears in status: channels, the most active threads, and
 * posts by others in the current goal since the viewer's last discussion
 * message. Posts a peer wrote while sealed count as new once they unseal.
 */
export function boardSummary(posts, session, viewer) {
  const channels = new Map();
  for (const post of posts) {
    const channel = channels.get(post.channel) ?? { name: post.channel, posts: 0 };
    channel.posts++;
    channel.lastSeq = post.seq;
    channel.lastActivityAt = post.createdAt;
    channels.set(post.channel, channel);
  }
  const summary = {
    posts: posts.length,
    channels: [...channels.values()]
      .sort((a, b) => b.lastSeq - a.lastSeq)
      .slice(0, 20)
      .map(({ lastSeq, ...channel }) => channel),
    recentThreads: listThreads(posts, session, {
      sort: 'activity',
      limit: 5,
      maxChars: PREVIEW_CHARS,
    }).results,
  };
  if (viewer && session) {
    const cutoff =
      session.messages.filter((m) => m.agent === viewer && m.round >= 1).at(-1)?.timestamp ??
      session.createdAt;
    const fresh = posts.filter(
      (p) => p.author !== viewer && p.sessionId === session.id && p.createdAt > cutoff,
    );
    summary.newForYou = {
      total: fresh.length,
      posts: fresh
        .slice(-10)
        .reverse()
        .map((p) => previewOf(p, session, PREVIEW_CHARS)),
    };
  }
  return summary;
}

export function renderBoard(posts) {
  if (!posts.length) return '# Board\n\nNo posts yet.\n';
  const channels = [...new Set(posts.map((p) => p.channel))].sort();
  const threads = threadIndex(posts);
  const entry = (heading, p) => `${heading} ${p.id} · ${p.author} · ${p.createdAt}\n\n${p.text}\n`;
  return (
    '# Board\n\nThis file is a generated view of `board.jsonl`. Post with `collab_board_post` or `model-collab board post`; do not edit this file.\n\n' +
    channels
      .map(
        (channel) =>
          `## ${channel}\n\n` +
          threads
            .filter((t) => t.root.channel === channel)
            .map(
              (t) =>
                entry('###', t.root) + t.replies.map((r) => `\n${entry('#### Reply', r)}`).join(''),
            )
            .join('\n'),
      )
      .join('\n')
  );
}
