import { rlTasks } from './rl-tasks.js';
/** Public specifications only. Private tests are loaded exclusively by the grader. */
export const codingTasks = [
  {
    id: 'ttl-lru',
    title: 'TTL-aware least-recently-used cache',
    specification: `Implement synchronous JavaScript function solve(capacity, operations).
capacity is a nonnegative integer. operations are arrays:
["put", key, value, ttl, now], ["get", key, now], or ["size", now].
Keys are strings; values are numbers, strings, or booleans. Times are nonnegative integers and never decrease. ttl is an integer or null (no expiration).
Before EVERY operation, remove all entries whose expiration time is <= now. put replaces any old entry, becomes most recently used, and expires at now + ttl. ttl <= 0 removes the old key without inserting anything. Capacity zero never stores entries. Evict least recently used live entries until capacity is respected. Successful get makes that key most recently used; size does not change recency.
Return one result per operation: null for put, stored value or null for get, live count for size.
Up to 10,000 operations. Use no external libraries, IO, timers, or module imports.`,
  },
  {
    id: 'weighted-intervals',
    title: 'Weighted half-open interval scheduling with exact ties',
    specification: `Implement synchronous JavaScript function solve(jobs).
Each job is {id, start, end, value}, with unique nonnegative integer id, integer start < end, and integer value (possibly negative). There are at most 2,000 jobs. Jobs occupy half-open intervals [start, end), so touching intervals are compatible.
Select any mutually compatible subset maximizing the sum of value (empty subset allowed). Return {value: maximum sum, ids: chosen ids sorted numerically ascending}.
Among equal-value subsets choose the lexicographically smallest sorted ids list, comparing numeric elements at the first difference; if one list is a prefix of another, the shorter list wins. Input order must not affect the answer.
Use no external libraries, IO, timers, or module imports.`,
  },
  {
    id: 'dependency-cycles',
    title: 'Dependency execution order and exact cycle membership',
    specification: `Implement synchronous JavaScript function solve(nodes).
nodes contains at most 2,000 objects {id: string, deps: string[]}. IDs are unique lowercase ASCII strings; every dependency names an existing node. Duplicate dependency entries count once. An edge means a node must wait for that dependency.
Return {order, cycles, blocked}. order is the sequence of executable IDs produced by repeatedly taking the lexicographically smallest currently ready node (all dependencies already executed), stopping when none are ready.
cycles contains each strongly connected component that is a directed cycle: size > 1, or a singleton with a self-dependency. Sort IDs inside each component lexicographically; sort components by their first ID. blocked is a lexicographically sorted list of unexecuted nodes that are NOT themselves members of any cycle (they depend directly or indirectly on one).
Do not put downstream blocked nodes inside cycles. Empty input returns three empty arrays. Use no external libraries, IO, timers, or module imports.`,
  },
];

export const tasks = [...codingTasks, ...rlTasks];
export const SUITES = Object.freeze({ coding: codingTasks, rl: rlTasks, all: tasks });

export function selectTasks(ids, suite = 'coding') {
  if (!SUITES[suite]) throw new Error(`Unknown evaluation suite: ${suite}`);
  if (!ids || ids.length === 0) return SUITES[suite];
  return ids.map(id => {
    const task = tasks.find(candidate => candidate.id === id);
    if (!task) throw new Error(`Unknown evaluation task: ${id}`);
    return task;
  });
}
