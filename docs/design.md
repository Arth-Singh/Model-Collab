# Design: how two agents should cooperate

Putting two strong models in a chat does not reliably produce a better answer.
Most of the ways it fails are old problems from human group work that now show
up in language models too. Model Collab is built around those failure modes. This
page lists what the research says and the protocol rule that answers each point.

## What goes wrong when agents talk

**Social influence erodes independence.** Seeing others' answers pulls
estimates together without making them more accurate. The crowd loses the
diversity that made it wise
([Lorenz et al., 2011](https://doi.org/10.1073/pnas.1008636108)). Language models
show the same conformity, and in many settings they are
[easier to mislead than to correct](https://www.alphaxiv.org/abs/2606.01637): a
peer's wrong answer flips a right one more often than the reverse. Sycophancy also
[spreads between agents](https://www.alphaxiv.org/abs/2604.02668).

**Debate is not a free improvement.** Multi-agent debate can improve reasoning
([Du et al., 2023](https://arxiv.org/abs/2305.14325)). But
it does not consistently beat simpler strategies at equal cost
([Smit et al., 2024](https://arxiv.org/abs/2311.17371)). Unguided debate between
similar models can do worse than
[isolated self-correction](https://www.alphaxiv.org/abs/2605.00914).

**Independent attempts fail together.** Programs written independently to the
same specification fail on the same inputs far more often than independence
would predict ([Knight and Leveson, 1986](https://doi.org/10.1109/TSE.1986.6312924)).
Similar models share blind spots, which undermines majority-style agreement
([Minority Sentinel, 2026](https://www.alphaxiv.org/abs/2606.29270)). Agreement
between two models is weak evidence.

**Groups discuss what everyone already knows.** Discussions favor shared
information and underuse facts that only one member holds
([Stasser and Titus, 1985](https://doi.org/10.1037/0022-3514.48.6.1467)).

**Execution settles what argument cannot.** Running two implementations on the
same inputs exposes defects that reading misses (McKeeman, "Differential
Testing for Software", _Digital Technical Journal_, 1998).
Generated tests used to cross-check candidate programs improve which one gets
selected ([CodeT, 2022](https://arxiv.org/abs/2207.10397)). Tests written apart
from the code catch more of its mistakes
([AgentCoder, 2023](https://arxiv.org/abs/2312.13010)).

## Protocol rules

| Finding                            | Rule in Model Collab                                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Influence erodes independence      | Each agent solves in its own Git worktree. Proposals stay sealed until both exist, as in a Delphi round.                                                                                                |
| Models conform and flip            | The contract allows changing an answer only for a failing input, a test result, or a quoted requirement, never because a peer disagrees or sounds sure. An `accept` must cite the accepter's own check. |
| Independent attempts fail together | Agents write tests from the specification before implementing, so tests encode the requirement rather than the code. The contract says agreement alone proves nothing.                                  |
| Unique information goes unshared   | The contract asks each agent to report what its peer may not know: requirements found in the code, implied edge cases, traps.                                                                           |
| Execution beats argument           | Cross-examination means running each agent's tests against the other's candidate in clean checkouts (`collab_checkout`) and checking where behavior differs.                                            |
| Debate costs more than it returns  | Proposing counts as voting. One acceptance ends the session. Each agent gets one message per round, equal candidates break ties by ID, and rounds are capped.                                           |

## Why no ping-pong

In the earlier shared-tree protocol, the shortest successful session took three
rounds. Both agents proposed a plan, then one integrated the chosen fix into
shared files while the other waited, then both accepted. In testing, a trivial
fix ran out its 12-minute budget in the interactive panes.

Now each agent implements and tests in its own worktree from the start, so a
proposal is already a runnable change. The shortest session is:

```text
round 0   codex: proposal m1          claude: proposal m2      (sealed, parallel)
round 1   claude: accept m1  ->  converged, m1 applied to your tree
          codex's round-1 turn is cancelled; it already voted by proposing
```

When the agents disagree, the next message must carry evidence: a failing
input, a revision that fixes a demonstrated defect, or a check result. When no
check can settle the question within the round limit, the session ends with the
alternatives recorded. It does not force agreement.

## What this does not claim

These rules come from published findings. They have not yet been shown to make
this pair better than a strong solo agent on your tasks. The
[early findings](findings.md) found no accuracy advantage on the tasks tested so
far. Run the comparison on work that matters to you before relying on it, and
judge it by results, not by how much the agents agreed.
