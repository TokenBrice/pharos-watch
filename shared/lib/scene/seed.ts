/**
 * Scene kit seeds. Geometry is pure: its only randomness is `seededStream(fnv1a(id))`, so the same input in any
 * order draws the same marks.
 */

/** FNV-1a 32-bit hash: the only seed source (`fnv1a(id)`). */
export function fnv1a(str: string): number {
  let h = 2166136261;
  for (let k = 0; k < str.length; k++) {
    h ^= str.charCodeAt(k);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 stream in [0, 1) from a 32-bit seed. */
export function seededStream(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
