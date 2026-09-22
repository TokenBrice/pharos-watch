/**
 * Escape every regex metacharacter in `value` so interpolated text cannot
 * change the pattern it is spliced into.
 *
 * Leaf module shared by the reserve-symbol matchers, the digest-signal
 * quarantine, and the worker reserve-adapter HTML helpers — each used to carry
 * its own byte-identical copy. `scripts/ci/check-doc-symbols.ts` still carries
 * one: the scripts tree is owned outside this lane.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
