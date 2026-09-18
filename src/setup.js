import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export const binPath = fileURLToPath(new URL('../bin/model-collab.js', import.meta.url));
export const peerContract = await fs.readFile(new URL('../prompts/peer.md', import.meta.url), 'utf8');
const interactiveTemplate = await fs.readFile(new URL('../prompts/interactive.md', import.meta.url), 'utf8');
export const researchContract = await fs.readFile(new URL('../prompts/research.md', import.meta.url), 'utf8');
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";

export function serverConfig(root, agent) {
  return { command: process.execPath, args: [binPath, 'serve', '--repo', path.resolve(root), '--agent', agent] };
}

export async function writeInstructions(root, participants, { preset = 'coding' } = {}) {
  const dir = path.join(root, '.collab');
  await fs.mkdir(path.join(dir, 'prompts'), { recursive: true });
  const contract = peerContract + (preset === 'research' ? '\n\n' + researchContract : '');
  for (const agent of participants) {
    await fs.writeFile(path.join(dir, 'prompts', `${agent}.md`), `Your participant ID is ${agent}.\n\n${contract}`);
    const replacements = { '%AGENT%': agent, '%REPO%': path.resolve(root), '%QUOTED_REPO%': shellQuote(path.resolve(root)), '%CLI%': `${shellQuote(process.execPath)} ${shellQuote(binPath)}`, '%PEER_CONTRACT%': contract };
    const text = interactiveTemplate.replace(/%AGENT%|%REPO%|%QUOTED_REPO%|%CLI%|%PEER_CONTRACT%/g, key => replacements[key]);
    await fs.writeFile(path.join(dir, `START-${agent.toUpperCase()}.md`), text);
  }
  await fs.writeFile(path.join(dir, 'CONTEXT.md'), '# Shared project context\n\nAdd architecture, constraints, relevant paths, and commands here. Both peers read this file.\nThe active goal and success criteria are in collab_status.\n', { flag: 'wx' }).catch(e => { if (e.code !== 'EEXIST') throw e; });
  if (preset === 'research') await fs.writeFile(path.join(dir, 'RESEARCH.md'), '# Research brief\n\n- Research question:\n- Environment / dataset:\n- Relevant papers and source locations:\n- Existing implementation and baselines:\n- Compute, time, and data constraints:\n- Success metrics and uncertainty:\n- Known findings and unresolved assumptions:\n\nFill this in with project-specific context. Leave unknowns explicit.\n', { flag: 'wx' }).catch(e => { if (e.code !== 'EEXIST') throw e; });
  const ignorePath = path.join(root, '.gitignore');
  const ignore = await fs.readFile(ignorePath, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
  if (!ignore.split(/\r?\n/).includes('.collab/')) await fs.writeFile(ignorePath, `${ignore}${ignore && !ignore.endsWith('\n') ? '\n' : ''}.collab/\n`);
}

export async function launch(root, agent, { model, effort = 'xhigh', print = false } = {}) {
  if (!['codex', 'claude'].includes(agent)) throw new Error('Launch supports codex or claude; other participants may connect through serve.');
  const prompt = `Stay in this visible interactive session. Read .collab/START-${agent.toUpperCase()}.md and .collab/CONTEXT.md, then follow those instructions to collaborate as ${agent}. Do not launch background workers. The user can interrupt or steer you in this pane.`;
  const config = serverConfig(root, agent);
  const interactiveInstructions = await fs.readFile(path.join(root, '.collab', `START-${agent.toUpperCase()}.md`), 'utf8');
  const command = agent;
  const args = agent === 'codex'
    ? ['-C', path.resolve(root), '-m', model ?? 'gpt-6-astra', '-c', `model_reasoning_effort=${JSON.stringify(effort)}`, '-c', `mcp_servers.model_collab.command=${JSON.stringify(config.command)}`, '-c', `mcp_servers.model_collab.args=${JSON.stringify(config.args)}`, prompt]
    : ['--model', model ?? 'claude-fable-5-1[1m]', '--effort', effort, '--mcp-config', JSON.stringify({ mcpServers: { model_collab: config } }), '--append-system-prompt', interactiveInstructions, prompt];
  if (print) return { command, args, cwd: path.resolve(root) };
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: false });
  return new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code, signal) => resolve({ exitCode: code ?? 1, signal })); });
}
