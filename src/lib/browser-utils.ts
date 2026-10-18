/**
 * Schedule work at idle, with a separately budgeted post-paint fallback.
 * `timeoutMs` bounds requestIdleCallback's idle wait; `fallbackDelayMs` runs
 * after two animation frames when idle callbacks are unavailable.
 * Returns a cleanup function for either scheduling path.
 */
export function scheduleIdle(
  callback: () => void,
  { timeoutMs, fallbackDelayMs }: { timeoutMs: number; fallbackDelayMs: number },
): () => void {
  const win = window as Window & {
    requestIdleCallback?: (cb: () => void, options?: { timeout?: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };

  if (typeof win.requestIdleCallback === "function") {
    const handle = win.requestIdleCallback(callback, { timeout: timeoutMs });
    return () => win.cancelIdleCallback?.(handle);
  }

  // Retain matching scheduling/cancellation APIs for this callback's lifetime.
  const requestFrame = window.requestAnimationFrame;
  const cancelFrame = window.cancelAnimationFrame;
  const setTimer: (handler: () => void, timeoutMs: number) => number = window.setTimeout.bind(window);
  const clearTimer: (handle: number) => void = window.clearTimeout.bind(window);
  let frame: number | undefined;
  let timeout: number | undefined;
  frame = requestFrame.call(window, () => {
    frame = requestFrame.call(window, () => {
      frame = undefined;
      timeout = setTimer(() => {
        timeout = undefined;
        callback();
      }, fallbackDelayMs);
    });
  });
  return () => {
    if (frame !== undefined) {
      cancelFrame.call(window, frame);
      frame = undefined;
    }
    if (timeout !== undefined) {
      clearTimer(timeout);
      timeout = undefined;
    }
  };
}
