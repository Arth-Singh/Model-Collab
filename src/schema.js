import { z } from 'zod';

export const agentId = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
const checkName = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const configSchema = z
  .object({
    preset: z.enum(['coding', 'research']).default('coding'),
    // Agents per backend. The swarm interleaves them: claude-1, codex-1, claude-2, ...
    claude: z.number().int().min(0).max(32).default(9),
    codex: z.number().int().min(0).max(32).default(9),
    models: z
      .object({ claude: z.string().min(1).optional(), codex: z.string().min(1).optional() })
      .strict()
      .default({}),
    effort: z.string().min(1).default('high'),
    // The whole run; sessions inside it; and how many sessions one agent may start.
    deadlineMinutes: z.number().min(0.1).max(1440).default(60),
    sessionMinutes: z.number().min(0.1).max(240).default(30),
    maxSessions: z.number().int().min(1).max(500).default(40),
    // The run finishes once every agent has waited this long with no new message.
    quietSeconds: z.number().min(1).max(3600).default(30),
    // Agents start this far apart, so the first claims are read before the next agent starts.
    staggerSeconds: z.number().min(0).max(120).default(3),
    // How many times failing checks may send the swarm back to work.
    maxCheckRounds: z.number().int().min(1).max(10).default(3),
    checkTimeoutSeconds: z.number().int().min(1).max(3600).default(300),
    checks: z.record(checkName, z.array(z.string().min(1)).min(1).max(30)).default({}),
    // Fold each finished run into .collab/MEMORY.md with one model call.
    memory: z.boolean().default(true),
    // Ignored directories, by name, that clones and checkouts link to.
    dependencyDirs: z
      .array(
        z
          .string()
          .regex(/^[^/\\]+$/)
          .refine((name) => !['.', '..', '.git', '.collab'].includes(name)),
      )
      .max(20)
      .default(['node_modules', '.venv', 'venv']),
    // TensorBoard scalars for every run, sampled every monitorSeconds, written
    // under tensorboardDir (default .collab/tensorboard, relative to the project).
    tensorboard: z.boolean().default(true),
    tensorboardDir: z.string().min(1).optional(),
    monitorSeconds: z.number().min(1).max(600).default(15),
    // A command run on main in a clean checkout every scoreSeconds; the last
    // "x/y" or number it prints is plotted as progress. Agents never run it.
    scoreCommand: z.array(z.string().min(1)).max(30).default([]),
    scoreSeconds: z.number().min(5).max(3600).default(120),
    // Extra environment variables agents may see; secrets stay out by default.
    passEnv: z.array(envName).max(50).default([]),
    chatCommand: z.string().min(1).default('swarmchat'),
  })
  .strict()
  .refine((config) => config.claude + config.codex >= 1, {
    message: 'A swarm needs at least one agent.',
  });

export const goalSchema = z
  .object({
    goal: z.string().trim().min(1).max(12000),
    criteria: z.array(z.string().trim().min(1).max(1000)).max(20).default([]),
  })
  .strict();
