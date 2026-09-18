// This module is never imported by the provider or included in model prompts.
import { privateRlTests } from './private-rl-tests.js';
function rng(seed) {
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

function cacheReference(capacity, operations) {
  const entries = new Map();
  return operations.map(([op, ...args]) => {
    const now = args.at(-1);
    for (const [key, entry] of entries) if (entry.expires <= now) entries.delete(key);
    if (op === 'size') return entries.size;
    const key = args[0];
    if (op === 'get') {
      if (!entries.has(key)) return null;
      const entry = entries.get(key);
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    }
    const [, value, ttl] = args;
    entries.delete(key);
    if (capacity > 0 && (ttl === null || ttl > 0)) {
      entries.set(key, { value, expires: ttl === null ? Infinity : now + ttl });
      while (entries.size > capacity) entries.delete(entries.keys().next().value);
    }
    return null;
  });
}

function lexCompare(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

function intervalsReference(jobs) {
  let best = { value: 0, ids: [] };
  for (let mask = 0; mask < 2 ** jobs.length; mask++) {
    const chosen = jobs.filter((_, i) => mask & (1 << i));
    const ordered = [...chosen].sort((a, b) => a.start - b.start);
    if (ordered.some((job, i) => i && ordered[i - 1].end > job.start)) continue;
    const value = chosen.reduce((sum, job) => sum + job.value, 0);
    const ids = chosen.map(job => job.id).sort((a, b) => a - b);
    if (value > best.value || (value === best.value && lexCompare(ids, best.ids) < 0)) best = { value, ids };
  }
  return best;
}

function dependencyReference(nodes) {
  const deps = new Map(nodes.map(n => [n.id, new Set(n.deps)]));
  const order = [], done = new Set();
  while (true) {
    const ready = nodes.map(n => n.id).filter(id => !done.has(id) && [...deps.get(id)].every(d => done.has(d))).sort();
    if (!ready.length) break;
    order.push(ready[0]); done.add(ready[0]);
  }
  // Independent reachability oracle: mutual reachability defines SCC membership.
  const reachable = new Map();
  for (const node of nodes) {
    const reached = new Set(), pending = [...node.deps];
    while (pending.length) {
      const id = pending.pop();
      if (reached.has(id)) continue;
      reached.add(id); pending.push(...deps.get(id));
    }
    reachable.set(node.id, reached);
  }
  const assigned = new Set(), cycles = [];
  for (const { id } of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    if (assigned.has(id) || !reachable.get(id).has(id)) continue;
    const component = nodes.map(n => n.id).filter(other => reachable.get(id).has(other) && reachable.get(other).has(id)).sort();
    component.forEach(other => assigned.add(other)); cycles.push(component);
  }
  return { order, cycles, blocked: nodes.map(n => n.id).filter(id => !done.has(id) && !assigned.has(id)).sort() };
}

export function privateTests(taskId) {
  if (taskId.startsWith('rl-')) return privateRlTests(taskId);
  const random = rng(90210);
  if (taskId === 'ttl-lru') {
    const inputs = [
      [0, [['put', 'a', 7, null, 0], ['get', 'a', 0], ['size', 0]]],
      [2, [['put', 'a', 1, 4, 0], ['put', 'b', false, null, 1], ['get', 'a', 3], ['size', 4], ['get', 'a', 4], ['get', 'b', 4]]],
      [2, [['put', 'a', 1, null, 0], ['put', 'b', 2, null, 0], ['get', 'a', 0], ['put', 'c', 3, null, 0], ['get', 'b', 0], ['size', 0]]],
      [2, [['put', '__proto__', 0, null, 0], ['put', 'constructor', '', null, 0], ['get', '__proto__', 0], ['put', '__proto__', 1, 0, 0], ['get', '__proto__', 0], ['get', 'constructor', 0]]],
      [2, [['put', 'a', 1, 1, 0], ['put', 'a', 2, null, 0], ['get', 'a', 1], ['put', 'a', 3, -1, 1], ['size', 1]]],
      [1, []],
    ];
    for (let sample = 0; sample < 12; sample++) {
      let now = 0;
      const operations = Array.from({ length: 150 }, () => {
        now += Math.floor(random() * 3);
        const key = `k${Math.floor(random() * 9)}`;
        const kind = random();
        if (kind < 0.5) return ['put', key, Math.floor(random() * 10), random() < .15 ? null : Math.floor(random() * 9) - 1, now];
        return kind < .85 ? ['get', key, now] : ['size', now];
      });
      inputs.push([sample % 5, operations]);
    }
    return inputs.map((args, i) => ({ name: `cache-${i + 1}`, args, expected: cacheReference(...args) }));
  }
  if (taskId === 'weighted-intervals') {
    const inputs = [[], [{ id: 3, start: 0, end: 1, value: -2 }],
      [{ id: 4, start: 0, end: 2, value: 4 }, { id: 2, start: 2, end: 4, value: 4 }, { id: 1, start: 0, end: 4, value: 8 }],
      [{ id: 3, start: 0, end: 1, value: 0 }, { id: 1, start: 1, end: 2, value: 5 }, { id: 0, start: -1, end: 0, value: 0 }],
      [{ id: 9, start: 0, end: 1, value: 5 }, { id: 2, start: 1, end: 2, value: 0 }, { id: 4, start: 2, end: 3, value: 0 }],
    ];
    for (let sample = 0; sample < 25; sample++) inputs.push(Array.from({ length: 10 }, (_, id) => {
      const start = Math.floor(random() * 9) - 2;
      return { id, start, end: start + 1 + Math.floor(random() * 4), value: Math.floor(random() * 9) - 2 };
    }).sort(() => random() - .5));
    const tests = inputs.map((jobs, i) => ({ name: `intervals-${i + 1}`, args: [jobs], expected: intervalsReference(jobs) }));
    const large = Array.from({ length: 2000 }, (_, id) => ({ id, start: id * 2, end: id * 2 + 1, value: 1 }));
    tests.push({ name: 'intervals-scale', args: [large.reverse()], expected: { value: 2000, ids: Array.from({ length: 2000 }, (_, i) => i) } });
    return tests;
  }
  if (taskId === 'dependency-cycles') {
    const inputs = [[], [{ id: 'a', deps: ['a'] }],
      [{ id: 'a', deps: ['b'] }, { id: 'b', deps: ['a'] }, { id: 'c', deps: ['b'] }, { id: 'd', deps: [] }, { id: 'e', deps: ['c'] }],
      [{ id: 'c', deps: ['b', 'b'] }, { id: 'a', deps: [] }, { id: 'b', deps: [] }],
      [{ id: 'a', deps: ['a'] }, { id: 'b', deps: ['c'] }, { id: 'c', deps: ['b'] }, { id: 'd', deps: ['a', 'b'] }, { id: 'e', deps: [] }],
    ];
    for (let sample = 0; sample < 24; sample++) {
      const ids = Array.from({ length: 8 }, (_, i) => String.fromCharCode(97 + i));
      inputs.push(ids.map(id => ({ id, deps: ids.filter(() => random() < .15) })).sort(() => random() - .5));
    }
    return inputs.map((nodes, i) => ({ name: `dependencies-${i + 1}`, args: [nodes], expected: dependencyReference(nodes) }));
  }
  throw new Error(`No private tests for task: ${taskId}`);
}
