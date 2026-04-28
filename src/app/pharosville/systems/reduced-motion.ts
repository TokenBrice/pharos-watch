type MM = (q: string) => MediaQueryList;

export function observeReducedMotion(
  cb: (matches: boolean) => void,
  matchMedia: MM = (q) => window.matchMedia(q),
): () => void {
  const mq = matchMedia("(prefers-reduced-motion: reduce)");
  cb(mq.matches);
  const handler = (e: { matches: boolean }) => cb(e.matches);
  mq.addEventListener("change", handler as (e: MediaQueryListEvent) => void);
  return () => mq.removeEventListener("change", handler as (e: MediaQueryListEvent) => void);
}
