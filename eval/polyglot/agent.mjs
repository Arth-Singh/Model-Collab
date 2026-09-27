// Shared agent invocation config so every arm runs under the same sandbox/env constraints.
import path from 'node:path';

export const CLAUDE_SETTINGS = {
  disableAllHooks: true,
  sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false },
};

/** Args for a solo headless Claude Code run; the prompt goes on stdin. */
export function claudeArgs(model) {
  return [
    '-p',
    '--model',
    model,
    '--output-format',
    'json',
    '--permission-mode',
    'acceptEdits',
    '--permission-prompts',
    'none',
    // Only these built-in tools exist; allow rules in the user's settings cannot add WebFetch.
    '--tools',
    'Read,Glob,Grep,Edit,Write,Bash',
    '--allowedTools',
    'Read,Glob,Grep,Edit,Write,Bash',
    '--settings',
    JSON.stringify(CLAUDE_SETTINGS),
    '--no-session-persistence',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--mcp-config',
    JSON.stringify({ mcpServers: {} }),
  ];
}

/**
 * Environment for agents working in `workspaceDir`. Sandboxed agents can only write inside the workspace,
 * so the Go build cache lives in <workspace>/.cache (gitignored; excluded from grading). Deps are offline-only.
 */
export function agentEnv(workspaceDir, base = process.env) {
  return {
    ...base,
    GOCACHE: path.join(workspaceDir, '.cache', 'go-build'),
    GOFLAGS: '-mod=mod',
    GOPROXY: 'off',
    GOTOOLCHAIN: 'local',
    GOWORK: 'off',
    CARGO_NET_OFFLINE: 'true',
    CARGO_TERM_COLOR: 'never',
  };
}
