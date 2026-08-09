/**
 * Runtime-neutral `AbortSignal` composition.
 *
 * One implementation of the "abort when any of these aborts" primitive, used by
 * the browser API client, the shared request lifecycle, and `timeout-signal`.
 * The `AbortSignal.any` fallback (older Workers/browsers) lives here only, and
 * every merge is disposable so a completed request can detach its listeners
 * instead of holding them until one of the sources aborts.
 */

export interface MergedAbortSignal {
  /** Aborted as soon as any input signal aborts. `undefined` when no input signal was supplied. */
  signal: AbortSignal | undefined;
  /** Detaches every listener this merge installed. Idempotent, and a no-op on the native path. */
  dispose: () => void;
}

const NO_CLEANUP = (): void => {};

/** Wrap an already-final signal (or none) in the disposable shape. */
export function staticAbortSignal(signal: AbortSignal | undefined): MergedAbortSignal {
  return { signal, dispose: NO_CLEANUP };
}

/**
 * Merge signals, ignoring nullish entries. Zero inputs yield `undefined`, a
 * single input is passed through unchanged, and the merged signal adopts the
 * `reason` of whichever source aborted first.
 */
export function mergeAbortSignals(inputs: readonly (AbortSignal | null | undefined)[]): MergedAbortSignal {
  const signals = inputs.filter((signal): signal is AbortSignal => signal != null);
  if (signals.length === 0) return staticAbortSignal(undefined);
  const [first] = signals;
  if (signals.length === 1) return staticAbortSignal(first);
  if (typeof AbortSignal.any === "function") return staticAbortSignal(AbortSignal.any([...signals]));

  const controller = new AbortController();
  let listeners: Array<readonly [AbortSignal, () => void]> = [];
  const dispose = () => {
    for (const [source, listener] of listeners) {
      source.removeEventListener("abort", listener);
    }
    listeners = [];
  };
  const abortFrom = (source: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(source.reason);
    dispose();
  };

  for (const source of signals) {
    if (source.aborted) {
      abortFrom(source);
      return { signal: controller.signal, dispose };
    }
  }

  for (const source of signals) {
    const listener = () => abortFrom(source);
    listeners.push([source, listener]);
    source.addEventListener("abort", listener, { once: true });
  }

  return { signal: controller.signal, dispose };
}
