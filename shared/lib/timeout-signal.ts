import { mergeAbortSignals } from "./abort-signals";

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

  const merged = mergeAbortSignals([parentSignal, timeoutController.signal]);

  return {
    // The timeout signal is always an input, so the merge never resolves to `undefined`.
    signal: merged.signal ?? timeoutController.signal,
    isTimedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timeoutId);
      merged.dispose();
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
