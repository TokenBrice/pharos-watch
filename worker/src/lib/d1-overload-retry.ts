import { abortReason, sleepWithSignal } from "./abort";

export function isRetriableD1OverloadError(err: unknown): boolean {
  const msg = String(err);
  return (
    msg.includes("D1 DB is overloaded") ||
    msg.includes("Requests queued for too long") ||
    msg.includes("D1 DB storage operation exceeded timeout") ||
    msg.includes("D1_ERROR: internal error; reference")
  );
}

const d1AbortReason = (signal: AbortSignal): unknown => abortReason(signal, () => new Error("aborted"));

export async function runWithOverloadRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  signal?: AbortSignal,
): Promise<T> {
  let attempt = 0;
  while (true) {
    if (signal?.aborted) throw d1AbortReason(signal);
    try {
      return await fn();
    } catch (err) {
      if (!isRetriableD1OverloadError(err) || attempt >= maxRetries) {
        throw err;
      }
      if (signal?.aborted) throw d1AbortReason(signal);
      const delayMs = Math.round(150 * 2 ** attempt * (0.5 + Math.random() * 0.5));
      await sleepWithSignal(delayMs, signal);
      attempt++;
    }
  }
}
