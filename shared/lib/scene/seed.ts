/**
 * Scene kit seeds. Geometry is pure: its only randomness is `seededStream(fnv1a32(id))`, so the same input in any
 * order draws the same marks.
 */

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
