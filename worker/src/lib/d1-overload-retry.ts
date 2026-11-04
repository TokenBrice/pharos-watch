import { abortReason, sleepWithSignal } from "./abort";

export function isRetriableD1OverloadError(err: unknown): boolean {
  const msg = String(err);
  return (
    msg.includes("D1 DB is overloaded") ||
    msg.includes("Requests queued for too long") ||
    msg.includes("D1 DB storage operation exceeded timeout") ||
    msg.includes("D1_ERROR: internal error; reference") ||
    msg.includes("Network connection lost")
  );
}

const d1AbortReason = (signal: AbortSignal): unknown => abortReason(signal, () => new Error("aborted"));

/**
 * D1 rejects a database whose resources over a rolling 10 s window are spent.
 * The sub-second backoff below retries inside that same window, so it cannot
 * succeed against this error.
 */
export const D1_RESOURCE_WINDOW_MS = 10_000;

function isD1ResourceWindowError(err: unknown): boolean {
  return String(err).includes("consumed within a 10 second window");
}

export interface OverloadRetryOptions {
  /**
   * Wait out one full resource window (once per call) before the next attempt.
   * For writes whose loss would misreport completed work, such as cron terminal
   * accounting; request paths keep the short backoff.
   */
  waitOutResourceWindow?: boolean;
}

export async function runWithOverloadRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  signal?: AbortSignal,
  options?: OverloadRetryOptions,
): Promise<T> {
  let attempt = 0;
  let waitedOutWindow = false;
  while (true) {
    if (signal?.aborted) throw d1AbortReason(signal);
    try {
      return await fn();
    } catch (err) {
      if (!isRetriableD1OverloadError(err) || attempt >= maxRetries) {
        throw err;
      }
      if (signal?.aborted) throw d1AbortReason(signal);
      const waitOutWindow: boolean = options?.waitOutResourceWindow === true && !waitedOutWindow && isD1ResourceWindowError(err);
      const delayMs = waitOutWindow
        ? D1_RESOURCE_WINDOW_MS + Math.round(Math.random() * 1_000)
        : Math.round(150 * 2 ** attempt * (0.5 + Math.random() * 0.5));
      waitedOutWindow ||= waitOutWindow;
      await sleepWithSignal(delayMs, signal);
      attempt++;
    }
  }
}
