// Grader-only deterministic oracles. Providers never import this module.
function randomGenerator(seed = 431907) {
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
const sum = xs => xs.reduce((a, b) => a + b, 0);
const mean = xs => sum(xs) / xs.length;

function gae(data) {
  const { rewards: r, values: v, nextValues: nv, terminated: term, truncated: trunc, gamma: g, lambda: l } = data;
  // Direct finite weighted sums, independent of the usual reverse recurrence.
  const advantages = r.map((_, start) => {
    let answer = 0;
    for (let end = start; end < r.length; end++) {
      answer += (g * l) ** (end - start) * (r[end] + (term[end] ? 0 : g * nv[end]) - v[end]);
      if (term[end] || trunc[end]) break;
    }
    return answer;
  });
  return { advantages, returns: advantages.map((a, i) => a + v[i]) };
}

function nstep(data) {
  const { rewards: r, nextValues: nv, terminated: term, truncated: trunc, gamma: g, n } = data;
  return r.map((_, start) => {
    let end = start;
    while (end + 1 < r.length && end + 1 < start + n && !term[end] && !trunc[end]) end++;
    // Backward nesting gives a second formulation of discounted reward sums.
    let target = term[end] ? 0 : nv[end];
    for (let i = end; i >= start; i--) target = r[i] + g * target;
    return target;
  });
}

function ppo(data) {
  const ids = data.mask.flatMap((valid, i) => valid === true ? [i] : []);
  if (!ids.length) return { policyLoss: 0, valueLoss: 0, clipFraction: 0, approxKL: 0 };
  let advantages = ids.map(i => data.advantages[i]);
  if (data.normalizeAdvantages) {
    const center = mean(advantages), variance = mean(advantages.map(a => (a - center) ** 2));
    advantages = advantages.map(a => (a - center) / Math.sqrt(variance + 1e-8));
  }
  const ratio = ids.map(i => Math.exp(data.newLogProbs[i] - data.oldLogProbs[i]));
  return {
    policyLoss: -mean(ratio.map((r, i) => advantages[i] >= 0 ? Math.min(r, 1 + data.epsilon) * advantages[i] : Math.max(r, 1 - data.epsilon) * advantages[i])),
    valueLoss: mean(ids.map(i => {
      const lower = data.oldValues[i] - data.valueClip, upper = data.oldValues[i] + data.valueClip;
      const clipped = data.newValues[i] < lower ? lower : data.newValues[i] > upper ? upper : data.newValues[i];
      return Math.max((data.newValues[i] - data.returns[i]) ** 2, (clipped - data.returns[i]) ** 2) / 2;
    })),
    clipFraction: ratio.filter(r => Math.abs(r - 1) > data.epsilon).length / ids.length,
    approxKL: mean(ids.map((i, j) => ratio[j] - 1 - (data.newLogProbs[i] - data.oldLogProbs[i]))),
  };
}

function matrixMultiply(a, b) {
  return a.map(row => b[0].map((_, j) => sum(row.map((value, k) => value * b[k][j]))));
}

function bellman(data) {
  const { transitions, policy, gamma, horizon, initialValues } = data, n = initialValues.length;
  // Construct an affine Bellman operator and exponentiate its augmented matrix.
  // This oracle does not share the candidate's likely sweep implementation.
  let operator = Array.from({ length: n + 1 }, () => Array(n + 1).fill(0));
  transitions.forEach((actions, s) => actions.forEach((outcomes, a) => outcomes.forEach(o => {
    const weight = policy[s][a] * o.p;
    operator[s][n] += weight * o.reward;
    if (!o.terminated) operator[s][o.next] += weight * gamma;
  })));
  operator[n][n] = 1;
  let power = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => +(i === j)));
  for (let exponent = horizon; exponent > 0; exponent = Math.floor(exponent / 2)) {
    if (exponent % 2) power = matrixMultiply(power, operator);
    operator = matrixMultiply(operator, operator);
  }
  const values = matrixMultiply(power, [...initialValues, 1].map(value => [value])).slice(0, n).map(row => row[0]);
  const qValues = transitions.map(actions => actions.map(outcomes => sum(outcomes.map(o => o.p * (o.reward + (o.terminated ? 0 : gamma * values[o.next]))))));
  return { values, qValues, greedyActions: qValues.map(row => row.indexOf(Math.max(...row))) };
}

function vtrace(data) {
  const { rewards: r, values: v, nextValues: nv, logRhos: logs, terminated: term, truncated: trunc, gamma: g, lambda: l, rhoClip, cClip, pgRhoClip } = data;
  const ratios = logs.map(Math.exp);
  const deltas = r.map((reward, i) => Math.min(rhoClip, ratios[i]) * (reward + (term[i] ? 0 : g * nv[i]) - v[i]));
  const vs = v.map((value, start) => {
    let correction = 0, product = 1;
    for (let end = start; end < r.length; end++) {
      correction += product * deltas[end];
      if (term[end] || trunc[end]) break;
      product *= g * l * Math.min(cClip, ratios[end]);
    }
    return value + correction;
  });
  const pgAdvantages = r.map((reward, i) => Math.min(pgRhoClip, ratios[i]) * (reward + (term[i] ? 0 : g * (i + 1 < r.length && !trunc[i] ? vs[i + 1] : nv[i])) - v[i]));
  return { vs, pgAdvantages };
}

function aggregate(data) {
  const tasks = [...data.tasks].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(task => {
    const eligible = task.runs.flatMap(run => {
      const ordered = run.checkpoints.map((point, index) => ({ ...point, index })).filter(point => point.step <= data.step).sort((a, b) => b.step - a.step || b.index - a.index);
      return ordered.length ? [{ seed: run.seed, value: (ordered[0].score - task.baseline) / (task.reference - task.baseline) }] : [];
    });
    const n = eligible.length, average = n ? mean(eligible.map(run => run.value)) : null;
    // Pairwise squared differences equal n times the sum of squared deviations.
    let pairwise = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairwise += (eligible[i].value - eligible[j].value) ** 2;
    return { id: task.id, n, seeds: eligible.map(run => run.seed).sort((a, b) => a - b), mean: average, standardError: n < 2 ? null : Math.sqrt(pairwise / (n * n * (n - 1))) };
  });
  const values = tasks.filter(task => task.n).map(task => task.mean).sort((a, b) => a - b), n = values.length;
  if (!n) return { tasks, macroMean: null, iqm: null };
  let area = 0;
  values.forEach((value, i) => { area += value * Math.max(0, Math.min(i + 1, .75 * n) - Math.max(i, .25 * n)); });
  return { tasks, macroMean: mean(values), iqm: area / (.5 * n) };
}

const oracles = { 'rl-gae-boundaries': gae, 'rl-nstep-targets': nstep, 'rl-ppo-clipped': ppo, 'rl-tabular-bellman': bellman, 'rl-vtrace': vtrace, 'rl-experiment-aggregate': aggregate };

export function privateRlTests(taskId) {
  const oracle = oracles[taskId];
  if (!oracle) throw new Error(`No private RL tests for ${taskId}`);
  const random = randomGenerator(), number = () => Math.floor(random() * 21) / 4 - 2;
  const trajectory = length => ({ rewards: Array.from({ length }, number), values: Array.from({ length }, number), nextValues: Array.from({ length }, number), terminated: Array.from({ length }, () => random() < .2), truncated: Array.from({ length }, () => random() < .2), gamma: .93, lambda: .81 });
  const inputs = [];
  if (taskId === 'rl-gae-boundaries' || taskId === 'rl-nstep-targets' || taskId === 'rl-vtrace') {
    inputs.push({ rewards: [1, 2], values: [2, 7], nextValues: [3, 4], terminated: [false, true], truncated: [true, true], gamma: .9, lambda: .8 });
    inputs.push(trajectory(0), trajectory(1));
    for (let i = 0; i < 24; i++) {
      const data = trajectory(3 + i);
      if (i % 6 === 0) data.gamma = 0;
      if (i % 6 === 1) data.gamma = 1;
      if (i % 5 === 0) data.lambda = 0;
      if (i % 5 === 1) data.lambda = 1;
      if (i % 7 === 0) { data.terminated.fill(false); data.truncated.fill(false); }
      inputs.push(data);
    }
    inputs.forEach((data, i) => {
      data.n = [1, 2, 5, 500][i % 4];
      data.logRhos = data.rewards.map((_, j) => Math.log([.1, 1, 3, 10][(i + j) % 4]));
      data.rhoClip = [1, 2, .5][i % 3]; data.cClip = [.4, 1, 2][i % 3]; data.pgRhoClip = [2, .5, 1][i % 3];
    });
  } else if (taskId === 'rl-ppo-clipped') {
    inputs.push({ oldLogProbs: [0, 0, 0, 0], newLogProbs: [Math.log(2), Math.log(.5), Math.log(2), Math.log(.5)], advantages: [1, 1, -1, -1], oldValues: [0, 0, 0, 0], newValues: [2, -2, .1, -.1], returns: [1, -1, 2, -2], mask: [true, true, true, true], epsilon: .2, valueClip: .2, normalizeAdvantages: false });
    for (let i = 0; i < 28; i++) {
      const n = i === 0 ? 0 : i + 1;
      inputs.push({ oldLogProbs: Array.from({ length: n }, () => -2), newLogProbs: Array.from({ length: n }, () => -2 + number()), advantages: Array.from({ length: n }, () => i % 5 === 0 ? 3 : number()), oldValues: Array.from({ length: n }, number), newValues: Array.from({ length: n }, number), returns: Array.from({ length: n }, number), mask: Array.from({ length: n }, (_, j) => i % 7 === 0 ? false : j % 3 !== 1), epsilon: i % 4 === 0 ? 0 : .2, valueClip: i % 3 === 0 ? 0 : .5, normalizeAdvantages: i % 2 === 0 });
    }
  } else if (taskId === 'rl-tabular-bellman') {
    inputs.push({ transitions: [[[{ p: 1, next: 1, reward: 1, terminated: false }]], [[{ p: 1, next: 0, reward: 2, terminated: false }]]], policy: [[1], [1]], initialValues: [0, 0], gamma: .5, horizon: 2 });
    inputs.push({ transitions: [[[{ p: 1, next: 0, reward: 2, terminated: true }], [{ p: 1, next: 0, reward: 2, terminated: true }]]], policy: [[.2, .8]], initialValues: [900], gamma: 1, horizon: 0 });
    for (let i = 0; i < 24; i++) {
      const n = 2 + i % 5, actions = 2 + i % 2;
      inputs.push({ transitions: Array.from({ length: n }, () => Array.from({ length: actions }, () => [.25, .75].map(p => ({ p, next: Math.floor(random() * n), reward: number(), terminated: random() < .3 })))), policy: Array.from({ length: n }, () => Array.from({ length: actions }, () => 1 / actions)), initialValues: Array.from({ length: n }, number), gamma: i % 5 === 0 ? 0 : .91, horizon: i % 6 === 0 ? 0 : i % 6 === 1 ? 40 : i % 7 });
    }
  } else {
    inputs.push({ step: 5, tasks: [
      { id: 'b', baseline: 0, reference: 10, runs: [{ seed: 2, checkpoints: [{ step: 3, score: 5 }, { step: 3, score: 15 }, { step: 9, score: 100 }] }] },
      { id: 'a', baseline: 10, reference: 20, runs: [{ seed: 9, checkpoints: [{ step: 4, score: 0 }] }, { seed: 1, checkpoints: [{ step: 5, score: 30 }] }] },
      { id: 'empty', baseline: 0, reference: 1, runs: [{ seed: 1, checkpoints: [{ step: 6, score: 10 }] }] },
    ] }, { step: 0, tasks: [] });
    for (let i = 0; i < 28; i++) inputs.push({ step: i % 7, tasks: Array.from({ length: 1 + i % 9 }, (_, j) => ({ id: `task-${9 - j}`, baseline: j - 3, reference: j + 7, runs: Array.from({ length: 1 + (i + j) % 6 }, (_, seed) => ({ seed: seed * 3, checkpoints: Array.from({ length: (i + j + seed) % 9 }, () => ({ step: Math.floor(random() * 10), score: number() * 5 })) })) })) });
  }
  return inputs.map((input, i) => ({ name: `${taskId}-${i + 1}`, args: [input], expected: oracle(input), tolerance: 1e-8 }));
}
