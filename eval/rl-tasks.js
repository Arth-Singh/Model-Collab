/** Public specifications. These measure RL implementation correctness, not training returns. */
export const rlTasks = [
  {
    id: 'rl-gae-boundaries', title: 'GAE across termination, truncation, and rollout boundaries', suite: 'rl',
    specification: `Implement synchronous function solve(data) returning {advantages, returns}.
data has equal-length arrays rewards, values, nextValues, terminated, truncated and scalars gamma, lambda in [0,1]. Length is 0..300. Numerical inputs are finite. nextValues[t] is the value of the actual next/final observation for transition t, NOT the reset observation. Adjacent transitions after a termination or truncation may belong to a new episode.
Use delta[t] = rewards[t] + gamma*(1-terminated[t])*nextValues[t] - values[t]. GAE sums discounted future deltas with multiplier gamma*lambda while staying in the SAME episode. Both termination and truncation stop propagation to the next transition. Only termination suppresses bootstrap in the current delta. If both flags are true, termination wins. At the end of the available rollout, the future GAE tail is zero but nextValues still provides the final bootstrap. returns[t] = advantages[t]+values[t]. Do not normalize advantages. Empty arrays produce empty arrays.`,
    sources: ['https://arxiv.org/html/1506.02438v6', 'https://gymnasium.farama.org/tutorials/gymnasium_basics/handling_time_limits/'],
  },
  {
    id: 'rl-nstep-targets', title: 'N-step returns with final-observation bootstrap', suite: 'rl',
    specification: `Implement synchronous function solve(data) returning an array of n-step value targets, one per transition.
data has equal-length arrays rewards, nextValues, terminated, truncated (length 0..300), integer n>=1 (at most 500), and gamma in [0,1]. All numbers are finite. The trajectory buffer can contain multiple episodes; nextValues[t] is the value of transition t's actual next/final observation, never a reset observation.
For each starting transition t, accumulate at most n rewards with successive discount powers. Stop after the first terminated OR truncated transition, or at the buffer's end. After consuming k transitions ending at j, add gamma^k*nextValues[j] unless terminated[j] is true. Thus truncation still bootstraps but must not consume rewards from the next episode. If both flags are true, termination wins. A buffer end without either flag also bootstraps. Empty input returns [].`,
    sources: ['https://arxiv.org/html/1506.02438v6', 'https://gymnasium.farama.org/tutorials/gymnasium_basics/handling_time_limits/'],
  },
  {
    id: 'rl-ppo-clipped', title: 'Masked PPO policy and value objectives', suite: 'rl',
    specification: `Implement synchronous function solve(data) returning {policyLoss, valueLoss, clipFraction, approxKL}.
data has equally sized arrays oldLogProbs, newLogProbs, advantages, oldValues, newValues, returns, mask; scalars epsilon in [0,1), valueClip>=0; boolean normalizeAdvantages. All numbers are finite, each log-probability difference is in [-15,15], and length is 0..1000. Only rows with mask[t] === true count in ANY average or normalization.
If normalizeAdvantages is true, center valid advantages by their mean and divide by sqrt(population variance + 1e-8). Otherwise leave them unchanged.
Let ratio=exp(newLogProb-oldLogProb). policyLoss is NEGATIVE mean(min(ratio*A, clamp(ratio,1-epsilon,1+epsilon)*A)). The min applies even when A is negative. Let clippedValue=oldValue+clamp(newValue-oldValue,-valueClip,valueClip). valueLoss=0.5*mean(max((newValue-return)^2,(clippedValue-return)^2)). clipFraction=mean(abs(ratio-1)>epsilon), using a strict comparison. approxKL=mean((ratio-1)-(newLogProb-oldLogProb)). If no rows are valid return all four values as zero.`,
    sources: ['https://arxiv.org/abs/1707.06347', 'https://spinningup.openai.com/en/latest/algorithms/ppo.html'],
  },
  {
    id: 'rl-tabular-bellman', title: 'Synchronous finite-horizon Bellman policy evaluation', suite: 'rl',
    specification: `Implement synchronous function solve(data) returning {values, qValues, greedyActions}.
data contains transitions[s][a], a nonempty array of outcomes {p,next,reward,terminated}; policy[s][a]; initialValues[s]; gamma in [0,1]; and integer horizon in [0,40]. There are 1..12 states, each with 1..5 actions. Outcome probabilities and policy probabilities are nonnegative and sum to one for each distribution. next is a valid state index; rewards and initialValues are finite. A terminated OUTCOME contributes reward but no next-state value, even when next points to a nonterminal state.
Starting from a copy of initialValues, apply exactly horizon SYNCHRONOUS Bellman expectation sweeps: each sweep computes every new state value from the entire previous vector, weighting all outcomes and all actions by their probabilities. Never update in place and never maximize during policy evaluation.
After the final sweep, compute qValues[s][a] as the one-step expected reward plus discounted final values, using the same termination rule. greedyActions[s] is the index of an action maximizing that qValue; exact ties choose the smallest action index. horizon zero retains initialValues but still computes qValues and greedyActions.`,
    sources: ['https://spinningup.openai.com/en/latest/spinningup/rl_intro.html'],
  },
  {
    id: 'rl-vtrace', title: 'V-trace values and policy advantages with separate clips', suite: 'rl',
    specification: `Implement synchronous function solve(data) returning {vs, pgAdvantages}.
data has equal-length arrays rewards, values, nextValues, logRhos, terminated, truncated (length 0..200); gamma and lambda in [0,1]; rhoClip>0, cClip>0, pgRhoClip>0. logRhos are in [-10,10]. All numbers are finite. nextValues are actual next/final-observation estimates. Consecutive transitions are in the same episode unless the current terminated or truncated flag is true.
Define ratio[t]=exp(logRhos[t]), rho[t]=min(rhoClip,ratio[t]), c[t]=lambda*min(cClip,ratio[t]), discount[t]=gamma*(1-terminated[t]), and delta[t]=rho[t]*(rewards[t]+discount[t]*nextValues[t]-values[t]).
The V-trace correction at t is delta[t] plus gamma*c[t] times the correction at t+1 only when t is neither terminated nor truncated and t+1 exists. vs[t]=values[t]+correction[t]. Rollout-end correction beyond the buffer is zero.
For policy advantages, bootstrap with vs[t+1] only if t+1 exists and t is neither terminated nor truncated; otherwise use nextValues[t]. pgAdvantages[t]=min(pgRhoClip,ratio[t])*(rewards[t]+discount[t]*bootstrap-values[t]). Both flags stop trace propagation; only termination suppresses bootstrap. Empty input returns two empty arrays.`,
    sources: ['https://arxiv.org/html/1802.01561v3', 'https://gymnasium.farama.org/tutorials/gymnasium_basics/handling_time_limits/'],
  },
  {
    id: 'rl-experiment-aggregate', title: 'Reproducible fixed-budget aggregation across tasks and seeds', suite: 'rl',
    specification: `Implement synchronous function solve(data) returning {tasks, macroMean, iqm}.
data is {step, tasks:[{id, baseline, reference, runs:[{seed, checkpoints:[{step,score}]}]}]}. Task IDs are unique ASCII strings, seeds are unique integers within each task, reference>baseline, and all numeric values are finite. At most 30 tasks, 30 runs/task, and 40 checkpoints/run. Checkpoints can be unsorted. Do not mutate input.
For each run select the checkpoint with largest step <= data.step; when that step occurs more than once, the LAST occurrence in the input wins. Exclude runs with no eligible checkpoint. Normalize each selected score as (score-baseline)/(reference-baseline); do not clip normalized scores.
Return tasks sorted lexicographically by id, each {id,n,seeds,mean,standardError}, where seeds are eligible seed IDs sorted numerically, n is their count, mean is mean normalized score (null if n=0), and standardError=sqrt(unbiased sample variance/n) (null if n<2).
macroMean weights each task with n>0 equally, regardless of its number of seeds. iqm is the interquartile mean of those TASK MEANS: sort them, view each as a constant unit-width bin, integrate between positions 0.25*m and 0.75*m, then divide by 0.5*m. Fractionally trim boundary bins; do not round the cutoffs. If no task has eligible runs, macroMean and iqm are null. This explicit task-mean IQM convention is part of this benchmark.`,
    sources: ['https://arxiv.org/html/2108.13264v4'],
  },
];
