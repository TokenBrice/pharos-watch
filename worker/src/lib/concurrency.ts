// Bounded-concurrency primitives for Worker code paths that fan out fetches.
// Cloudflare counts outbound requests while they wait for response headers.
// Pharos deliberately applies a stricter six-request trigger-wide budget, so
// callers must declare a ceiling that leaves headroom for sidecar work. No
// defaults: pick a number on purpose.

import { throwIfAborted } from "./abort";

function normalizeCap(maxInFlight: number, label: string): number {
  if (!Number.isFinite(maxInFlight) || Math.floor(maxInFlight) !== maxInFlight || maxInFlight < 1) {
    throw new RangeError(`${label} requires maxInFlight to be a positive integer (received ${maxInFlight}).`);
  }
  return maxInFlight;
}

/**
 * Runs `fn` against each item with at most `maxInFlight` invocations active at
 * once. Results are returned in the same order as `items`, even though the
 * underlying scheduling is unordered.
 *
 * If any `fn` invocation rejects, the returned promise rejects with the first
 * such error. Already-running tasks continue to completion but their results
 * are discarded; new work stops being scheduled.
 *
 * When `options.signal` is supplied the abort is checked before any work is
 * scheduled and again before each iteration picks up its next item, so an
 * aborted trigger stops enqueuing without waiting for the whole fan-out.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  maxInFlight: number,
  fn: (item: T, index: number) => Promise<R>,
  options?: { signal?: AbortSignal },
): Promise<R[]> {
  const cap = normalizeCap(maxInFlight, "mapWithConcurrency");
  const signal = options?.signal;
  throwIfAborted(signal);

  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  let nextIndex = 0;
  let firstError: unknown = undefined;
  const errorSentinel = Symbol("mapWithConcurrency.error");

  const worker = async (): Promise<void> => {
    for (;;) {
      if (firstError !== undefined) return;
      try {
        throwIfAborted(signal);
      } catch (err) {
        if (firstError === undefined) firstError = err ?? errorSentinel;
        return;
      }
      const i = nextIndex++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        if (firstError === undefined) firstError = err ?? errorSentinel;
        return;
      }
    }
  };

  const workerCount = Math.min(cap, items.length);
  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) workers.push(worker());
  await Promise.all(workers);

  if (firstError !== undefined) {
    throw firstError === errorSentinel ? new Error("mapWithConcurrency task rejected") : firstError;
  }
  return results;
}
