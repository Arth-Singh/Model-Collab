// Shared task prompt. Every arm (solo or collaborative) must use taskPrompt(task) verbatim.
function naturalList(items) {
  if (items.length === 0) throw new Error('taskPrompt: task has no solution files');
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

export function taskPrompt(task) {
  const files = naturalList(task.solutionFiles);
  return (
    `Implement the exercise described in INSTRUCTIONS.md in this repository by editing ${files}. ` +
    'Keep the public interface expected by the stub and instructions (names, signatures, error types/messages). ' +
    'A hidden test suite will grade the final files; you cannot see it. ' +
    'You may write and run your own tests. ' +
    `Finish with the final implementation saved in ${files}.`
  );
}
