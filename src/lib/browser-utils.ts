/**
 * Schedule a callback during an idle period, falling back to setTimeout.
 * `timeoutMs` is passed to requestIdleCallback's timeout option and also
 * used as the fallback setTimeout delay. Returns a cleanup function.
 */
export function scheduleIdle(callback: () => void, timeoutMs: number): () => void {
  const win = window as Window & {
    requestIdleCallback?: (cb: () => void, options?: { timeout?: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };

  if (typeof win.requestIdleCallback === "function") {
    const handle = win.requestIdleCallback(callback, { timeout: timeoutMs });
    return () => win.cancelIdleCallback?.(handle);
  }

  const timeout = window.setTimeout(callback, timeoutMs);
  return () => window.clearTimeout(timeout);
}
