/**
 * Iterative Tarjan traversal from the supplied starts, following every target.
 * Components (including singletons/self-loops) are yielded in DFS completion
 * order, with members in stack-pop order. Callers own sorting and early exit.
 */
export function* stronglyConnectedComponents(
  starts: Iterable<string>,
  targetsOf: (id: string) => Iterable<string>,
): Generator<string[]> {
  const indices = new Map<string, number>(), low = new Map<string, number>();
  const stack: string[] = [], onStack = new Set<string>();
  let nextIndex = 0;
  function enter(id: string) {
    indices.set(id, nextIndex);
    low.set(id, nextIndex++);
    stack.push(id);
    onStack.add(id);
    return { id, targets: targetsOf(id)[Symbol.iterator]() };
  }
  for (const start of starts) {
    if (indices.has(start)) continue;
    const work = [enter(start)];
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const target = frame.targets.next();
      if (!target.done) {
        if (!indices.has(target.value)) work.push(enter(target.value));
        else if (onStack.has(target.value)) low.set(frame.id, Math.min(low.get(frame.id)!, indices.get(target.value)!));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!));
      if (low.get(frame.id) !== indices.get(frame.id)) continue;
      const members: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        members.push(member);
      } while (member !== frame.id);
      yield members;
    }
  }
}
