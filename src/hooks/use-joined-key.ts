/**
 * Joins an array of string IDs into a pipe-delimited string suitable for use
 * as a stable `useEffect` dependency. Both scroll-spy components use this
 * pattern to avoid referential instability from inline array literals.
 *
 * Usage: `const key = useJoinedKey(ids); useEffect(() => { ... }, [key]);`
 */
export function useJoinedKey(ids: string[]): string {
  return ids.join("|");
}
