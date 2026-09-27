import fs from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from './process.js';

// Flags the unattended workers and the memory update pass; older CLIs lack them.
const REQUIRED_FLAGS = {
  codex: { help: ['exec', '--help'], flags: ['--ignore-rules', '--output-schema'] },
  claude: { help: ['--help'], flags: ['--permission-prompts', '--safe-mode', '--json-schema'] },
};

async function toolCheck(run, command, flag, remedy) {
  const result = await run([command, flag], { timeoutMs: 5000, maxBytes: 4000 });
  const ok = result.code === 0 && !result.error;
  const check = {
    name: command,
    ok,
    detail: ok ? (result.stdout || result.stderr).trim().split('\n')[0] : remedy,
  };
  const required = REQUIRED_FLAGS[command];
  if (!ok || !required) return check;
  const help = await run([command, ...required.help], { timeoutMs: 10000, maxBytes: 200000 });
  const text = `${help.stdout ?? ''}${help.stderr ?? ''}`;
  const missing = required.flags.filter((name) => !text.includes(name));
  if (help.code === 0 && !help.error && !missing.length) return check;
  return {
    ...check,
    ok: false,
    detail: `${check.detail} lacks ${missing.join(', ') || 'readable help'}; update ${command} to the latest version.`,
  };
}

export async function doctor({ root = process.cwd(), run = runCommand } = {}) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const checks = [
    { name: 'Node.js', ok: major > 22 || (major === 22 && minor >= 12), detail: process.version },
  ];
  checks.push(
    ...(await Promise.all(
      [
        ['git', '--version', 'Install Git, then run this check again.'],
        ['tmux', '-V', 'Install tmux, then run this check again.'],
        ['codex', '--version', 'Install the Codex CLI and sign in with codex.'],
        ['claude', '--version', 'Install Claude Code and sign in with claude.'],
      ].map(([command, flag, remedy]) => toolCheck(run, command, flag, remedy)),
    )),
  );
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
  if (directory && checks.find((check) => check.name === 'git').ok) {
    const repo = await run(['git', '-C', directory, 'rev-parse', '--show-toplevel'], {
      timeoutMs: 5000,
      maxBytes: 4000,
    });
    const ok = repo.code === 0 && !repo.error;
    checks.push({
      name: 'Git repository',
      ok,
      detail: ok
        ? repo.stdout.trim()
        : `${directory} is not in a Git repository. Run model-collab from your project, or run git init there.`,
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
