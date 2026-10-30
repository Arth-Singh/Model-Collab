# Security

Model Collab starts a swarm of coding agents that edit files and run commands
in your repository. Report a problem that lets an agent act outside those
limits, for example:

- an agent writing outside its clone, its Git directory, and the shared origin,
  or reaching the network or the local chat server directly;
- an agent speaking in the chat as another agent, as you, or as the supervisor;
- a chat message or repository file that makes the tool run a command, change
  settings, or apply a change the user did not approve;
- credentials reaching agents' environments, the chat, project memory,
  transcripts, or logs;
- agent processes or chat servers left running after a run ends.

Report it privately through
[GitHub's vulnerability reporting](https://github.com/Arth-Singh/Model-Collab/security/advisories/new),
not in a public issue. Include the version or commit, your operating system,
the Codex and Claude Code versions, and the steps that reproduce it.

Sandboxing itself belongs to Codex and Claude Code. Report a bypass of their
sandboxes to OpenAI or Anthropic as well.
