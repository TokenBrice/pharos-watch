export interface TimeoutSignalHandle {
  signal: AbortSignal;
  dispose: () => void;
  isTimedOut: () => boolean;
}

interface CreateTimeoutSignalOptions {
  timeoutMs: number;
  timeoutReason: string | Error | DOMException;
  parentSignal?: AbortSignal;
}

function normalizeTimeoutReason(reason: string | Error | DOMException): Error | DOMException {
  return typeof reason === "string" ? new Error(reason) : reason;
}

export function createTimeoutSignal({
  timeoutMs,
  timeoutReason,
  parentSignal,
}: CreateTimeoutSignalOptions): TimeoutSignalHandle {
  const normalizedReason = normalizeTimeoutReason(timeoutReason);
  const timeoutController = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    timeoutController.abort(normalizedReason);
  }, timeoutMs);

  let cleanupParentListener = () => {};
  let signal: AbortSignal;

  if (parentSignal && typeof AbortSignal.any === "function") {
    signal = AbortSignal.any([parentSignal, timeoutController.signal]);
  } else if (parentSignal) {
    const combinedController = new AbortController();
    const abortFromParent = () => combinedController.abort(parentSignal.reason);
    const abortFromTimeout = () => combinedController.abort(timeoutController.signal.reason);

    if (parentSignal.aborted) {
      abortFromParent();
    } else {
      parentSignal.addEventListener("abort", abortFromParent, { once: true });
    }
    timeoutController.signal.addEventListener("abort", abortFromTimeout, { once: true });

    cleanupParentListener = () => {
      parentSignal.removeEventListener("abort", abortFromParent);
      timeoutController.signal.removeEventListener("abort", abortFromTimeout);
    };
    signal = combinedController.signal;
  } else {
    signal = timeoutController.signal;
  }

  return {
    signal,
    isTimedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timeoutId);
      cleanupParentListener();
    },
  };
}

export async function raceWithTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutReason: string | Error | DOMException,
): Promise<T> {
  const timeout = createTimeoutSignal({ timeoutMs, timeoutReason });
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeout.signal.addEventListener(
          "abort",
          () => reject(timeout.signal.reason ?? normalizeTimeoutReason(timeoutReason)),
          { once: true },
        );
      }),
    ]);
  } finally {
    timeout.dispose();
  }
}
