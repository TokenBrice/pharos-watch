export interface DirectedLink {
  from: string;
  to: string;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function adjacency(ids: readonly string[], links: readonly DirectedLink[]) {
  const out = new Map<string, string[]>(ids.map(id => [id, []]));
  for (const link of links) out.get(link.from)?.push(link.to);
  for (const targets of out.values()) targets.sort(compareIds);
  return out;
}

/**
 * Returns the members of the first non-trivial strongly connected component
 * (or a self-loop), sorted by id, or null for an acyclic graph. Iterative
 * Tarjan so a long chain cannot overflow the stack.
 */
export function findDependencyCycle(ids: readonly string[], links: readonly DirectedLink[]): string[] | null {
  const out = adjacency(ids, links);
  for (const link of links) if (link.from === link.to) return [link.from];
  const index = new Map<string, number>(), low = new Map<string, number>();
  const stack: string[] = [], onStack = new Set<string>();
  let next = 0;
  for (const start of [...ids].sort(compareIds)) {
    if (index.has(start)) continue;
    const work: { id: string; child: number }[] = [{ id: start, child: 0 }];
    index.set(start, next); low.set(start, next++); stack.push(start); onStack.add(start);
    while (work.length) {
      const frame = work[work.length - 1]!;
      const targets = out.get(frame.id) ?? [];
      if (frame.child < targets.length) {
        const target = targets[frame.child++]!;
        if (!index.has(target)) {
          index.set(target, next); low.set(target, next++); stack.push(target); onStack.add(target);
          work.push({ id: target, child: 0 });
        } else if (onStack.has(target)) low.set(frame.id, Math.min(low.get(frame.id)!, index.get(target)!));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!));
      if (low.get(frame.id) !== index.get(frame.id)) continue;
      const members: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        members.push(member);
      } while (member !== frame.id);
      if (members.length > 1) return members.sort(compareIds);
    }
  }
  return null;
}

/**
 * Longest-path layer from a coin with no published upstream. Requires an
 * acyclic input; callers run findDependencyCycle first.
 */
export function longestPathLayers(ids: readonly string[], links: readonly DirectedLink[]): Map<string, number> {
  const out = adjacency(ids, links);
  const pending = new Map<string, number>(ids.map(id => [id, 0]));
  for (const link of links) pending.set(link.to, (pending.get(link.to) ?? 0) + 1);
  const layer = new Map<string, number>(ids.map(id => [id, 0]));
  const ready = ids.filter(id => pending.get(id) === 0).sort(compareIds);
  for (let i = 0; i < ready.length; i++) {
    const id = ready[i]!;
    for (const target of out.get(id) ?? []) {
      layer.set(target, Math.max(layer.get(target)!, layer.get(id)! + 1));
      const count = pending.get(target)! - 1;
      pending.set(target, count);
      if (count === 0) ready.push(target);
    }
  }
  return layer;
}

/** Weakly connected components, each sorted by id, largest first (ties by first id). */
export function partitionBasins(ids: readonly string[], links: readonly DirectedLink[]): string[][] {
  const parent = new Map<string, string>(ids.map(id => [id, id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(id) !== root) { const next = parent.get(id)!; parent.set(id, root); id = next; }
    return root;
  };
  for (const link of links) {
    const a = find(link.from), b = find(link.to);
    if (a !== b) parent.set(compareIds(a, b) < 0 ? b : a, compareIds(a, b) < 0 ? a : b);
  }
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const root = find(id);
    const group = groups.get(root);
    if (group) group.push(id); else groups.set(root, [id]);
  }
  return [...groups.values()]
    .map(group => group.sort(compareIds))
    .sort((a, b) => b.length - a.length || compareIds(a[0]!, b[0]!));
}
