import { z } from 'zod';

export const agentId = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
export const sessionIdSchema = z.string().uuid();
export const configSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  preset: z.enum(['coding', 'research']).default('coding'),
  participants: z.array(agentId).min(2).max(8).refine(v => new Set(v).size === v.length, 'Participants must be unique'),
  maxRounds: z.number().int().min(1).max(12).default(4),
  maxMessages: z.number().int().min(4).max(100).default(24),
  deadlineMinutes: z.number().min(0.01).max(240).default(20),
  checks: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/), z.array(z.string().min(1)).min(1).max(30)).default({}),
}).strict();

export const messageSchema = z.object({
  clientMessageId: z.string().min(8).max(80),
  contextVersion: z.number().int().min(0).optional(),
  kind: z.enum(['proposal', 'challenge', 'evidence', 'accept', 'blocked']),
  summary: z.string().trim().min(1).max(2000),
  evidence: z.array(z.string().trim().min(1).max(1000)).max(10).default([]),
  candidate: z.string().max(80).optional(),
  solution: z.string().max(16000).optional(),
  files: z.array(z.string().min(1).max(500)).max(50).default([]),
  repliesTo: z.string().max(80).optional(),
  resolves: z.array(z.string().max(80)).max(10).default([]),
}).strict();

// Native transports carry the observed session separately from the stored message.
export const nativePostSchema = messageSchema.extend({ sessionId: sessionIdSchema });

export const startSchema = z.object({
  topic: z.string().trim().min(1).max(12000),
  successCriteria: z.array(z.string().trim().min(1).max(1000)).max(20).default([]),
}).strict();
