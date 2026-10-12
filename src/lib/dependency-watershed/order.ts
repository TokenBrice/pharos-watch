export interface OrderItem {
  id: string;
  /** Upstream item in the previous column this item is grouped under, if any. */
  primaryParent: string | null;
  /** Sort magnitude within a tributary group (known USD; unknown sorts as 0). */
  value: number;
}

export interface OrderSegment {
  from: string;
  to: string;
  /** Barycenter weight; must be positive. */
  weight: number;
}

const SWEEPS = ["down", "up", "down", "up"] as const;

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Tributary ordering: group each column under its primary parent's position,
 * then by value descending, then id. Four weighted barycenter sweeps follow;
 * ties keep the previous position, so the result is a pure function of input.
 * The source column stays in value order so the largest upstream heads the
 * stage; only downstream columns move to their barycenters.
 */
export function orderColumns(columns: readonly (readonly OrderItem[])[], segments: readonly OrderSegment[]): string[][] {
  const ordered: string[][] = [];
  columns.forEach((column, c) => {
    const previous = new Map((ordered[c - 1] ?? []).map((id, index) => [id, index]));
    const parentRank = (item: OrderItem) => item.primaryParent !== null && previous.has(item.primaryParent) ? previous.get(item.primaryParent)! : Number.MAX_SAFE_INTEGER;
    ordered.push([...column].sort((a, b) => parentRank(a) - parentRank(b) || b.value - a.value || compareIds(a.id, b.id)).map(item => item.id));
  });
  const up = new Map<string, OrderSegment[]>(), down = new Map<string, OrderSegment[]>();
  for (const segment of segments) {
    const into = up.get(segment.to);
    if (into) into.push(segment); else up.set(segment.to, [segment]);
    const from = down.get(segment.from);
    if (from) from.push(segment); else down.set(segment.from, [segment]);
  }
  for (const direction of SWEEPS) {
    const range = direction === "down"
      ? Array.from({ length: Math.max(0, ordered.length - 1) }, (_, i) => i + 1)
      : Array.from({ length: Math.max(0, ordered.length - 2) }, (_, i) => ordered.length - 2 - i);
    for (const c of range) {
      const neighbor = new Map(ordered[direction === "down" ? c - 1 : c + 1]!.map((id, index) => [id, index]));
      const bary = new Map<string, number>();
      ordered[c]!.forEach((id, index) => {
        let total = 0, weight = 0;
        for (const segment of (direction === "down" ? up.get(id) : down.get(id)) ?? []) {
          const position = neighbor.get(direction === "down" ? segment.from : segment.to);
          if (position === undefined) continue;
          total += position * segment.weight;
          weight += segment.weight;
        }
        // Unconnected items keep their slot relative to the column's scale.
        bary.set(id, weight > 0 ? total / weight : index * (neighbor.size / Math.max(1, ordered[c]!.length)));
      });
      const previous = new Map(ordered[c]!.map((id, index) => [id, index]));
      ordered[c] = [...ordered[c]!].sort((a, b) => bary.get(a)! - bary.get(b)! || previous.get(a)! - previous.get(b)!);
    }
  }
  return ordered;
}
