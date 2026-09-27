# Security

Model Collab starts coding agents that edit files and run commands in your
repository. Report a problem that lets an agent act outside those limits, for
example:

- an unattended worker writing outside its worktree or reaching the network;
- a peer message, board post, or repository file that makes the tool run a
  command, change settings, or apply a change the user did not approve;
- credentials reaching the board, project memory, transcripts, or logs.

Report it privately through
[GitHub's vulnerability reporting](https://github.com/Arth-Singh/Model-Collab/security/advisories/new),
not in a public issue. Include the version or commit, your operating system,
the Codex and Claude Code versions, and the steps that reproduce it.

Sandboxing itself belongs to Codex and Claude Code. Report a bypass of their
sandboxes to OpenAI or Anthropic as well.
