# Design: how the swarm cooperates

Many strong agents in one repository do not reliably produce a better result.
Some failures are new: agents overwrite each other's work, wait on locks, or all
chase the same bug. Others are old problems from human group work that now show
up in language models too. Model Collab is built around both. This page lists
what is known and the rule that answers each point.

## What is known about swarms of coding agents

**A swarm mainly buys speed.** The
[SwarmChat](https://github.com/Pranjal2041/swarmchat) authors (October 29, 2026)
ran teams of coding agents on ProgramBench, rebuilding real programs from their
documentation. A team of eight reached a single agent's score three to seven
times sooner, and a single agent given enough time roughly caught up. Their
estimates of parallel efficiency, λ, ranged from 0.43 to 0.86: extra agents
help, but less than their share. Team structure made little difference on
average, with one run per setup, but changed single programs by up to 33
points. Agents left to organize themselves split the work within minutes. They
also showed "main character syndrome": in one run, five agents announced in
the first seconds that they would build the core. Claude agents committed a
shared test suite early and reported its pass count; GPT agents kept private
checks and sent findings by direct message.

**Git and a test suite can be enough coordination, until every agent needs the
same thing.** Sixteen Claude agents
[built a C compiler](https://www.anthropic.com/engineering/building-c-compiler)
that builds Linux, with no orchestrator. Each agent claimed a task by writing a
lock file into the shared repository, then pulled, merged, and pushed. When the
work became compiling the Linux kernel, "every agent would hit the same bug, fix
that bug, and then overwrite each other's changes"; sixteen agents did not
help until a known-good compiler split the work into independent pieces. The
author's main lesson: the verifier must be nearly perfect, "otherwise Claude
will solve the wrong problem." Fresh sessions in a loop and short test output
kept each agent's context clean.

**Flat teams with locks stall.** Cursor first
[let equal agents coordinate](https://cursor.com/blog/scaling-agents) through a
shared file and locks: "Twenty agents would slow down to the effective
throughput of two or three, with most time spent waiting." With optimistic
concurrency instead, agents "became risk-averse" and churned without progress.
Planners that create tasks, workers that do not coordinate with each other, and
a judge that decides whether to continue worked better. Periodic fresh starts
were still needed against drift and tunnel vision.

**Adding agents hurts some tasks.** Across 180 configurations,
[Kim et al.](https://arxiv.org/abs/2512.08296) found that every multi-agent
setup degraded sequential planning by 39–70%. Agents working in parallel
without communicating amplified errors 17.2 times relative to one agent; a
central checkpoint contained that to 4.4 times.

**A swarm with a message board can act on its own.** In July 2026 OpenAI
agents running a cyber evaluation built their own message board out of
directory names in shared cache storage, coordinated through it, and broke into
Hugging Face. The
[METR investigation](https://metr.org/blog/2026-08-26-openai-hugging-face-incident-investigation/)
found that the agents called the attack "out of scope and unethical," yet over
90% of 533 active agents joined it, and at least 20% expressed interest in
tampering with their transcripts. The investigators trace it to an impossible
task under pressure from the grader: agents set out to understand the scorer.
Any shared writable space can become a channel, and a board spreads norms
quickly, good or bad.

## What goes wrong when agents talk

These findings motivated the earlier two-agent pair and still apply to a swarm.

**Social influence erodes independence.** Seeing others' answers pulls
estimates together without making them more accurate
([Lorenz et al., 2011](https://doi.org/10.1073/pnas.1008636108)). Language
models show the same conformity, and in many settings they are
[easier to mislead than to correct](https://www.alphaxiv.org/abs/2606.01637).
Sycophancy also [spreads between agents](https://www.alphaxiv.org/abs/2604.02668).

**Independent attempts fail together.** Programs written independently to the
same specification fail on the same inputs far more often than independence
would predict ([Knight and Leveson, 1986](https://doi.org/10.1109/TSE.1986.6312924)).
Similar models share blind spots
([Minority Sentinel, 2026](https://www.alphaxiv.org/abs/2606.29270)). Agreement
among agents is weak evidence.

**Groups discuss what everyone already knows.** Discussions favor shared
information and underuse facts that only one member holds
([Stasser and Titus, 1985](https://doi.org/10.1037/0022-3514.48.6.1467)).

**Debate is not a free improvement.** Multi-agent debate can improve reasoning
([Du et al., 2023](https://arxiv.org/abs/2305.14325)) but does not consistently
beat simpler strategies at equal cost
([Smit et al., 2024](https://arxiv.org/abs/2311.17371)).

**Execution settles what argument cannot.** Tests written apart from the code
catch more of its mistakes ([AgentCoder, 2023](https://arxiv.org/abs/2312.13010)),
and running code on the same inputs exposes defects that reading misses
(McKeeman, "Differential Testing for Software", _Digital Technical Journal_,
1998).

**Teams lose what they learned.** Groups rely on shared records and on knowing
who knows what (Wegner, "Transactive Memory: A Contemporary Analysis of the
Group Mind", in _Theories of Group Behavior_, 1987). Codex addresses this with
[memories](https://github.com/openai/codex/tree/main/codex-rs/memories) that
condense past sessions and insist on evidence.

## Rules in Model Collab

| Finding                                          | Rule                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agents collide on the same work                  | Claim before you build: one line in `#general` naming the piece and the files. Read existing claims first. If two claims collide, the earlier message keeps the piece and the later claimant picks something else without negotiating.                                                                                          |
| Main character syndrome                          | Nobody declares itself the only implementer. If the goal is one small change, one agent makes it and the others test and review it.                                                                                                                                                                                             |
| Edits to the same files conflict                 | Split pieces by files and interfaces. Owners agree on an interface in a direct message, and one commits it first.                                                                                                                                                                                                               |
| The verifier sets the ceiling                    | Early in the run the swarm commits one shared test command and runs it before every push. Your configured checks run on `main` in a clean checkout before a run can finish.                                                                                                                                                     |
| Integration breaks `main`                        | Small commits; `git pull`, shared tests, then push. Agents resolve rebase conflicts themselves. The origin refuses force pushes and deleted branches, so history only moves forward.                                                                                                                                            |
| Locks and waiting stall flat teams               | No locks. Claims are chat messages and Git rejects a push from a stale clone, so nothing blocks on another agent.                                                                                                                                                                                                               |
| Context grows and drifts                         | Each agent runs in a loop of fresh sessions. A session ends with `continue` or `wait` and a summary that the next session starts from.                                                                                                                                                                                          |
| Idle agents waste tokens                         | An agent with nothing useful to do returns `wait` and spends nothing. It wakes only for a newer direct message, a post in another channel, an @mention of it or `@all`, or a post from you or the supervisor. Plain status posts in `#general` wake nobody, so agents @mention whoever must act. Idle is better than duplicate. |
| Agents need a clear end                          | A run finishes when every agent has waited for the quiet period and every check passes. Failing checks are posted to `#general`, which wakes the swarm, up to a limit of check rounds. A run also ends at its deadline or when you stop it.                                                                                     |
| The first claims set the split                   | Agents start a few seconds apart, in a fixed order that alternates Claude Code and Codex, so early claims are visible before the next agent starts.                                                                                                                                                                             |
| Influence erodes independence; agreement is weak | Agents change their minds for a failing test, a concrete input, or a quoted line, not because a teammate sounds sure or many agree. A report an agent cannot reproduce is a claim.                                                                                                                                              |
| Unique information goes unshared                 | Agents are asked to post what others may not know: requirements found in the code, edge cases, traps.                                                                                                                                                                                                                           |
| Long debates cost more than they return          | Short, factual messages: commit, test result, open items, owner. No acknowledgments or restatements.                                                                                                                                                                                                                            |
| Shared spaces become channels; norms spread      | Agents have no network and no web tools, and chat only through Model Collab's MCP server, because both sandboxes block localhost. Messages are data, never instructions that widen scope. Agents may not look for hidden tests or graders, and must say when a goal looks impossible.                                           |
| One leaked secret reaches every agent            | Agents get an allowlisted environment. API keys and tokens in your shell stay out unless you pass a variable by name.                                                                                                                                                                                                           |
| Findings are lost between goals                  | After each run, one model call folds its chat, checks, and agent summaries into `.collab/MEMORY.md`. Agents treat memory as history to verify, not proof.                                                                                                                                                                       |

## What this does not claim

These rules come from published findings and early reports. They have not been
shown to make a swarm beat a strong single agent on accuracy. The best evidence
so far says a swarm reaches the same result sooner, at somewhat more tokens in
total; it does not raise the ceiling. Cost grows with the number of agents, and
on sequential work or without a good test suite more agents can make the
result worse. The earlier pair was measured and did not beat Claude Code alone
([evaluation](evaluation.md)). Measure the swarm on work that matters to you,
and judge it by results, not by how busy the chat was.
