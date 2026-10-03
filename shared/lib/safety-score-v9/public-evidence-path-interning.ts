import type { V9PublicEvidenceFactWire } from "../../types/safety-score-v9-public-evidence-facts";

/** Producer-only: rows were just authored and are owned by this projection. */
export function internEvidenceFactPathPrefixes(rows: V9PublicEvidenceFactWire[]): string[] | undefined {
  if (rows.length < 2) return undefined;
  const counts = new Map<string, number>();
  for (const row of rows) {
    const path = row[1], base = typeof path === "string" ? path : Array.isArray(path) ? path[0] : undefined;
    if (typeof base !== "string") throw new Error("Fact path interning requires literal producer paths");
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  const candidates = new Map<string, number>(), byPath = new Map<string, string[]>();
  for (const [path, count] of counts) {
    const prefixes: string[] = [];
    for (let at = path.indexOf(":"); at !== -1; at = path.indexOf(":", at + 1)) {
      if (at + 1 >= 12) prefixes.push(path.slice(0, at + 1));
    }
    if (path.length >= 12 && prefixes[prefixes.length - 1] !== path) prefixes.push(path);
    byPath.set(path, prefixes);
    for (const prefix of prefixes) candidates.set(prefix, (candidates.get(prefix) ?? 0) + count);
  }
  // Conservative overhead covers tuple brackets, three-digit refs and table keys.
  const worthwhile = (prefix: string, count: number) => count * (prefix.length - 8) > prefix.length + 25;
  const active = new Set<string>();
  for (const [prefix, count] of candidates) if (worthwhile(prefix, count)) active.add(prefix);
  const choices = new Map<string, string>(), usage = new Map<string, number>();
  while (active.size > 0) {
    choices.clear(); usage.clear();
    for (const [path, count] of counts) {
      const prefixes = byPath.get(path)!;
      for (let i = prefixes.length - 1; i >= 0; i--) {
        const prefix = prefixes[i]!;
        if (!active.has(prefix)) continue;
        choices.set(path, prefix); usage.set(prefix, (usage.get(prefix) ?? 0) + count); break;
      }
    }
    let pruned = false;
    for (const [prefix, count] of usage) if (!worthwhile(prefix, count)) { active.delete(prefix); pruned = true; }
    if (!pruned) break;
  }
  if (active.size === 0 || usage.size === 0) return undefined;
  const prefixes = [...usage.keys()].sort(), refs = new Map<string, number>();
  for (let ref = 0; ref < prefixes.length; ref++) refs.set(prefixes[ref]!, ref);
  for (const row of rows) {
    const path = row[1], base = typeof path === "string" ? path : Array.isArray(path) ? path[0] : undefined;
    if (typeof base !== "string") throw new Error("Fact path interning requires literal producer paths");
    const prefix = choices.get(base);
    if (prefix === undefined) continue;
    const ref = refs.get(prefix)!;
    const suffix = base.slice(prefix.length);
    if (typeof path === "string") row[1] = suffix === "" ? ref : [ref, suffix];
    else if (Array.isArray(path)) {
      if (suffix === "") {
        const causeRef = path[1];
        if (causeRef === undefined) row[1] = [ref];
        else if (typeof causeRef === "number") row[1] = [ref, causeRef];
        else throw new Error("Fact path interning requires a literal causal reference");
      }
      else {
        const causeRef = path[1] ?? row[2] ?? row[6][0];
        if (typeof causeRef !== "number") throw new Error("Causal fact path has no reference");
        row[1] = [ref, `${suffix}:cause:${causeRef}`];
      }
    }
  }
  return prefixes;
}
