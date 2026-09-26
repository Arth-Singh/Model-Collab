import { z } from 'zod';

export const agentId = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
export const sessionIdSchema = z.string().uuid();
export const configSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    preset: z.enum(['coding', 'research']).default('coding'),
    participants: z
      .array(agentId)
      .min(2)
      .max(8)
      .refine((v) => new Set(v).size === v.length, 'Participants must be unique')
      .refine((v) => !v.includes('user'), "'user' is reserved for the human on the board"),
    maxRounds: z.number().int().min(1).max(12).default(3),
    maxMessages: z.number().int().min(4).max(100).default(24),
    deadlineMinutes: z.number().min(0.01).max(240).default(30),
    checkTimeoutSeconds: z.number().int().min(1).max(3600).default(300),
    // Ignored directories, by name, that worktrees and checkouts link to.
    dependencyDirs: z
      .array(
        z
          .string()
          .regex(/^[^/\\]+$/)
          .refine((name) => !['.', '..', '.git', '.collab'].includes(name)),
      )
      .max(20)
      .default(['node_modules', '.venv', 'venv']),
    checks: z
      .record(
        z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
        z.array(z.string().min(1)).min(1).max(30),
      )
      .default({}),
  })
  .strict();

export const messageSchema = z
  .object({
    clientMessageId: z.string().min(8).max(80),
    contextVersion: z.number().int().min(0).optional(),
    kind: z.enum(['proposal', 'challenge', 'evidence', 'accept', 'blocked']),
    summary: z.string().trim().min(1).max(2000),
    evidence: z.array(z.string().trim().min(1).max(1000)).max(10).default([]),
    candidate: z.string().max(80).optional(),
    solution: z.string().max(16000).optional(),
    repliesTo: z.string().max(80).optional(),
    resolves: z.array(z.string().max(80)).max(10).default([]),
  })
  .strict();

// Native transports carry the observed session separately from the stored message.
export const nativePostSchema = messageSchema.extend({ sessionId: sessionIdSchema });

export const startSchema = z
  .object({
    topic: z.string().trim().min(1).max(12000),
    successCriteria: z.array(z.string().trim().min(1).max(1000)).max(20).default([]),
  })
  .strict();

export const channelName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,47}$/, {
  message: 'Channel names use 1-48 lowercase letters, digits, dots, dashes, or underscores.',
});
export const postId = z.string().regex(/^p[1-9][0-9]*$/, { message: 'Post IDs look like p12.' });
const pageFields = {
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z
    .string()
    .regex(/^[0-9]+$/)
    .optional(),
  maxChars: z.number().int().min(1).max(4000).default(1000),
};

// A board post goes to exactly one destination: a channel (a new thread) or a thread (a reply).
export const boardPostSchema = z
  .object({
    text: z.string().trim().min(1).max(8000),
    channel: channelName.optional(),
    thread: postId.optional(),
    requestId: z.string().min(8).max(80).optional(),
  })
  .strict();

export const boardSearchSchema = z
  .object({
    query: z.string().max(200).optional(),
    channel: channelName.optional(),
    author: z.string().max(32).optional(),
    after: postId.optional(),
    ...pageFields,
  })
  .strict();

export const boardThreadsSchema = z
  .object({
    channel: channelName.optional(),
    sort: z.enum(['activity', 'created']).default('activity'),
    ...pageFields,
  })
  .strict();

export const boardReadThreadSchema = z.object({ thread: postId, ...pageFields }).strict();

export const boardReadPostSchema = z
  .object({
    post: postId,
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(20000).default(20000),
  })
  .strict();
