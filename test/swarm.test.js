import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { ChatClient, readTranscript } from '../src/chat.js';
import { Store } from '../src/store.js';
import { applyLatest, rosterFor, runSwarm, sessionPrompt, stopRun } from '../src/swarm.js';
import { configSchema } from '../src/schema.js';
import { gitProject, scalarsIn, writeFiles } from './helpers.js';

const skip =
  spawnSync('swarmchat', ['--version']).status === 0 ? false : 'swarmchat is not installed';
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const fast = { quietSeconds: 1, staggerSeconds: 0, deadlineMinutes: 2, memory: false };

/** Commit files in an agent's clone and push them to main, rebasing if needed. */
async function push(workspace, files, message) {
  await writeFiles(workspace, files);
  git(workspace, 'add', '-A');
  git(workspace, 'commit', '-q', '-m', message);
  for (let attempt = 0; ; attempt++) {
    try {
      git(workspace, 'pull', '-q');
      git(workspace, 'push', '-q', 'origin', 'HEAD:main');
      return;
    } catch (error) {
      if (attempt > 5) throw error;
    }
  }
}

/** A stand-in for the agent CLIs: `plan` decides what each session does. */
function scripted(root, plan) {
  const sessions = [];
  const session = async ({ agent, prompt, signal }) => {
    const store = new Store(root);
    const { run } = await store.read();
    const tokens = JSON.parse(await fs.readFile(store.tokensFile, 'utf8'));
    const chat = new ChatClient({
      command: run.chat.command,
      url: run.chat.url,
      token: tokens[agent.id],
    });
    sessions.push({ agent: agent.id, number: agent.sessions, prompt });
    const result = await plan({ agent, number: agent.sessions, chat, signal, prompt });
    return {
      usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, costUsd: 0.01 },
      wallMs: 1,
      ...result,
    };
  };
  return { session, sessions };
}

const untilAborted = (signal) =>
  new Promise((resolve) =>
    signal.addEventListener(
      'abort',
      () => resolve({ failure: { kind: 'aborted', message: 'The run ended.' } }),
      { once: true },
    ),
  );

test('agents are interleaved by backend and told who they are', () => {
  const config = configSchema.parse({ claude: 3, codex: 1 });
  assert.deepEqual(
    rosterFor(config).map((a) => a.id),
    ['claude-1', 'codex-1', 'claude-2', 'claude-3'],
  );
  const run = {
    goal: 'Build the parser',
    criteria: ['Handles empty input'],
    deadlineAt: new Date(Date.now() + 600000).toISOString(),
    agents: rosterFor(config),
  };
  const prompt = sessionPrompt({
    run,
    config: configSchema.parse({ checks: { test: ['npm', 'test'] } }),
    agent: { id: 'codex-1', workspace: '/w', sessions: 2, lastSummary: 'Lexer half done' },
    context: 'CONTEXT.md\nUse pnpm.',
  });
  assert.match(prompt, /^# Model Collab swarm contract/);
  assert.match(
    prompt,
    /You are codex-1, one of 4 agents: claude-1, claude-2, claude-3 \(Claude Code\); codex-1 \(Codex\)/,
  );
  assert.match(prompt, /This is your session 2/);
  assert.match(prompt, /Lexer half done/);
  assert.match(prompt, /test: npm test/);
  assert.match(prompt, /Build the parser[\s\S]*- Handles empty input/);
  assert.match(prompt, /Use pnpm/);
});

test('a quiet swarm whose checks pass has its result applied', { skip }, async (t) => {
  const root = await gitProject(t, 'model-collab-swarm-');
  const events = [];
  const { session, sessions } = scripted(root, async ({ agent, number, chat }) => {
    await chat.read();
    if (number === 1 && agent.id === 'claude-1') {
      await chat.send('#general', 'I take the lexer: lexer.js');
      await push(agent.workspace, { 'lexer.js': 'lexer\n' }, 'Add lexer');
    }
    if (number === 1 && agent.id === 'codex-1') {
      await chat.send('#general', 'I take the CLI: cli.js');
      await push(agent.workspace, { 'cli.js': 'cli\n' }, 'Add CLI');
    }
    await chat.read();
    return { next: 'wait', summary: `session ${number} done` };
  });
  const run = await runSwarm({
    root,
    goal: 'Build a lexer and a CLI',
    criteria: ['Both files exist'],
    overrides: {
      ...fast,
      claude: 1,
      codex: 1,
      checks: { both: ['sh', '-c', 'test -f lexer.js && test -f cli.js'] },
      monitorSeconds: 1,
      scoreSeconds: 5,
      scoreCommand: ['sh', '-c', 'echo "SCORE $(ls *.js 2>/dev/null | wc -l | tr -d " ")/2"'],
    },
    session,
    onEvent: (event) => events.push(event),
  });
  assert.equal(run.status, 'finished', run.stopReason);
  assert.deepEqual(run.result.applied, ['cli.js', 'lexer.js']);
  assert.equal(await fs.readFile(path.join(root, 'lexer.js'), 'utf8'), 'lexer\n');
  assert.equal(git(root, 'rev-parse', 'refs/model-collab/result'), run.result.commit);
  assert.equal(run.result.commits, 2);
  assert.deepEqual(
    run.checkRounds.map((round) => round.results[0].passed),
    [true],
  );
  assert.deepEqual(
    events
      .filter((e) => e.event === 'push')
      .map((e) => e.author)
      .sort(),
    ['claude-1', 'codex-1'],
  );
  assert.equal(events.at(-1).event, 'score');
  assert.ok(events.every((e) => typeof e.at === 'string'));
  assert.deepEqual(
    { score: run.result.score.score, fraction: run.result.score.fraction },
    { score: 2, fraction: 1 },
  );
  const monitorDir = events.find((e) => e.event === 'monitor').dir;
  assert.match(monitorDir, /\.collab\/tensorboard\/.*_2agents_build-a-lexer-and-a-cli$/);
  const samples = await scalarsIn(monitorDir);
  const last = (tag) => samples.filter((e) => tag in e.scalars).at(-1)?.scalars[tag];
  assert.equal(last('main/commits'), 2);
  assert.equal(last('main/committers'), 2);
  assert.equal(last('progress/score_fraction'), 1);
  assert.equal(last('agent_commits/codex-1'), 1);
  assert.equal(last('checks/passed_fraction'), 1);
  assert.ok(last('tokens/total') >= 200);
  assert.ok(last('chat/general') >= 3);
  assert.match(sessions[0].prompt, /You are claude-1/);
  assert.ok(run.agents.every((a) => a.usage.inputTokens >= 100 && a.state === 'stopped'));

  const transcript = await readTranscript(path.join(root, '.collab', 'chat'));
  assert.equal(transcript[0].from, 'user');
  assert.match(transcript[0].text, /^Goal \(run .*\):\nBuild a lexer and a CLI/);
  assert.ok(transcript.some((m) => m.from === 'claude-1' && /lexer/.test(m.text)));
  assert.match(transcript.at(-1).text, /^Run finished/);
  const state = await new Store(root).read();
  assert.equal(state.run.status, 'finished');
  assert.match(await fs.readFile(path.join(root, '.collab', 'README.md'), 'utf8'), /finished/);
});

test('failing checks wake the waiting swarm until a fix lands', { skip }, async (t) => {
  const root = await gitProject(t, 'model-collab-swarm-');
  const { session, sessions } = scripted(root, async ({ agent, chat }) => {
    const unread = await chat.read();
    if (agent.id === 'claude-1' && unread.some((m) => /Checks failed/.test(m.text)))
      await push(agent.workspace, { 'fixed.txt': 'ok\n' }, 'Fix the check');
    return { next: 'wait', summary: 'nothing left' };
  });
  const run = await runSwarm({
    root,
    goal: 'Make the check pass',
    overrides: { ...fast, claude: 1, codex: 1, checks: { fixed: ['test', '-f', 'fixed.txt'] } },
    session,
  });
  assert.equal(run.status, 'finished', run.stopReason);
  assert.deepEqual(
    run.checkRounds.map((round) => round.results[0].passed),
    [false, true],
  );
  assert.ok(sessions.filter((s) => s.agent === 'claude-1').length >= 2);
  assert.deepEqual(run.result.applied, ['fixed.txt']);
});

test('plain status posts wake nobody; mentions and direct messages do', { skip }, async (t) => {
  const root = await gitProject(t, 'model-collab-swarm-');
  const { session, sessions } = scripted(root, async ({ agent, number, chat }) => {
    await chat.read();
    if (agent.id === 'codex-1' && number === 1) {
      // Give the others time to finish their first session and start waiting.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await chat.send('#general', 'Pushed the parser; nothing open.');
      await chat.send('#general', '@claude-1 please review the parser.');
      await chat.send('claude-2', 'Can you take the docs?');
    }
    await chat.read();
    return { next: 'wait', summary: 'done' };
  });
  await runSwarm({
    root,
    goal: 'Test waking',
    overrides: { ...fast, claude: 2, codex: 1 },
    session,
  });
  const count = (id) => sessions.filter((s) => s.agent === id).length;
  assert.equal(count('claude-1'), 2, 'the mention woke claude-1 once');
  assert.equal(count('claude-2'), 2, 'the direct message woke claude-2 once');
  assert.equal(count('codex-1'), 1, 'nobody addressed codex-1');
});

test(
  'a stop request ends the run without applying, and apply takes the result later',
  { skip },
  async (t) => {
    const root = await gitProject(t, 'model-collab-swarm-');
    const { session } = scripted(root, async ({ agent, number, signal }) => {
      if (number === 1) {
        await push(agent.workspace, { 'half.txt': 'half\n' }, 'Half the work');
        await stopRun(root, 'the user changed plans');
      }
      return untilAborted(signal);
    });
    const run = await runSwarm({
      root,
      goal: 'Do a long job',
      overrides: { ...fast, claude: 1, codex: 0 },
      session,
    });
    assert.equal(run.status, 'stopped');
    assert.equal(run.stopReason, 'the user changed plans');
    assert.equal(run.result.applied, null);
    assert.deepEqual(run.result.files, ['half.txt']);
    await assert.rejects(fs.access(path.join(root, 'half.txt')));
    assert.deepEqual(await applyLatest(root), ['half.txt']);
    assert.equal(await fs.readFile(path.join(root, 'half.txt'), 'utf8'), 'half\n');
  },
);

test('failing sessions back off, then retire the agent, and the run fails', { skip }, async (t) => {
  const root = await gitProject(t, 'model-collab-swarm-');
  const events = [];
  const { session, sessions } = scripted(root, async () => ({
    failure: { kind: 'rate_limited', message: "You've hit your usage limit." },
  }));
  const run = await runSwarm({
    root,
    goal: 'Anything',
    overrides: { ...fast, claude: 1, codex: 0 },
    session,
    retryDelays: { error: 5, rate_limited: 5 },
    onEvent: (event) => events.push(event),
  });
  assert.equal(run.status, 'failed');
  assert.equal(run.stopReason, 'every agent retired');
  assert.equal(sessions.length, 5);
  assert.equal(run.agents[0].rateLimited, 5);
  assert.match(run.agents[0].retiredReason, /5 failed sessions in a row/);
  assert.equal(events.filter((e) => e.event === 'failed').length, 4);
  assert.equal(run.result.applied, null);
});

test(
  'the deadline ends a busy run, and a run left by a dead supervisor is archived',
  { skip },
  async (t) => {
    const root = await gitProject(t, 'model-collab-swarm-');
    const store = new Store(root);
    await store.init({ memory: false });
    await store.update((state) => {
      state.run = {
        kind: 'swarm',
        id: 'stale-run',
        status: 'running',
        supervisorPid: 2 ** 22 + 12345,
        createdAt: new Date().toISOString(),
        agents: [],
      };
    });
    const { session } = scripted(root, ({ signal }) => untilAborted(signal));
    const started = Date.now();
    const run = await runSwarm({
      root,
      goal: 'Never finishes',
      overrides: { ...fast, claude: 1, codex: 1, deadlineMinutes: 0.1 },
      session,
    });
    assert.equal(run.status, 'expired');
    assert.ok(Date.now() - started >= 5000);
    const stale = JSON.parse(
      await fs.readFile(path.join(root, '.collab', 'history', 'stale-run.json'), 'utf8'),
    );
    assert.equal(stale.status, 'failed');
    assert.match(stale.stopReason, /supervisor exited/);
  },
);

test(
  'stop closes a run whose supervisor died, keeping its result for apply',
  { skip },
  async (t) => {
    const root = await gitProject(t, 'model-collab-swarm-');
    const { session } = scripted(root, async ({ agent, signal }) => {
      await push(agent.workspace, { 'kept.txt': 'kept\n' }, 'Work before the crash');
      return untilAborted(signal);
    });
    const controller = new AbortController();
    const running = runSwarm({
      root,
      goal: 'Crash halfway',
      overrides: { ...fast, claude: 1, codex: 0 },
      session,
      signal: controller.signal,
      onEvent: (event) => event.event === 'push' && controller.abort(),
    });
    await running;
    // Make the finished run look like one whose supervisor was killed mid-run.
    const store = new Store(root);
    await store.update((state) => {
      state.run.status = 'running';
      state.run.supervisorPid = 2 ** 22 + 54321;
      state.run.result = null;
      state.run.endedAt = null;
    });
    const closed = await stopRun(root, 'cleaning up');
    assert.equal(closed.status, 'stopped');
    assert.match(closed.stopReason, /supervisor had already exited/);
    assert.equal(closed.result.commits, 1);
    assert.deepEqual(await applyLatest(root), ['kept.txt']);
  },
);
