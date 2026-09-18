import fs from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from './process.js';

export async function doctor({ root = process.cwd(), run = runCommand } = {}) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const checks = [
    { name: 'Node.js', ok: major > 22 || (major === 22 && minor >= 12), detail: process.version },
  ];
  const tools = await Promise.all(
    [
      ['tmux', '-V', 'Install tmux, then run this check again.'],
      ['codex', '--version', 'Install the Codex CLI and sign in with codex.'],
      ['claude', '--version', 'Install Claude Code and sign in with claude.'],
    ].map(async ([command, flag, remedy]) => {
      const result = await run([command, flag], { timeoutMs: 5000, maxBytes: 4000 });
      const ok = result.code === 0 && !result.error;
      return {
        name: command,
        ok,
        detail: ok ? (result.stdout || result.stderr).trim().split('\n')[0] : remedy,
      };
    }),
  );
  checks.push(...tools);
  let directory;
  try {
    directory = await fs.realpath(root);
    if (!(await fs.stat(directory)).isDirectory()) throw new Error('Not a directory');
  } catch {
    checks.push({
      name: 'Project directory',
      ok: false,
      detail: `Directory not found: ${path.resolve(root)}`,
    });
  }
  return {
    ok: checks.every((check) => check.ok),
    root: directory ?? path.resolve(root),
    checks,
    note: 'This checks local tools. Sign in to Codex and Claude Code before starting a collaboration.',
  };
}

export function renderDoctor(result) {
  return [
    'Model Collab setup',
    '',
    ...result.checks.map(
      (check) => `${check.ok ? 'OK' : 'MISSING'}  ${check.name}: ${check.detail}`,
    ),
    '',
    result.ok
      ? 'Ready to start a session.'
      : 'Resolve the missing requirements, then run model-collab doctor again.',
    result.note,
  ].join('\n');
}
