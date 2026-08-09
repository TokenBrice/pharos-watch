export function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === "string" && reason.length > 0) return new Error(reason);
  return new Error("Operation aborted");
}

/**
 * The signal's own abort reason, verbatim, falling back to `fallback()` when
 * the platform supplied none.
 *
 * Unlike `abortError`, non-Error reasons pass through unchanged — `DOMException`
 * is not an `Error` subclass in Workers, and downstream `name === "AbortError"`
 * checks depend on it surviving. Each caller therefore keeps its own fallback:
 * stream readers must throw an `AbortError`-named `DOMException`, while D1 and
 * budget waiters throw a plain `Error`. Changing a site's fallback type is a
 * behavior change, not a cleanup.
 */
export function abortReason(signal: AbortSignal, fallback: () => unknown): unknown {
  return signal.reason ?? fallback();
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}

export function rethrowIfAborted(error: unknown, signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError(signal);
  }
  if (error instanceof Error && error.name === "AbortError") {
    throw error;
  }
  if (typeof error === "object" && error !== null && "name" in error && (error as { name?: string }).name === "AbortError") {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  throwIfAborted(signal);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError(signal));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function yieldToEventLoop(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);

  await new Promise<void>((resolve, reject) => {
    let channel: {
      port1: { close: () => void };
      port2: { close: () => void };
    } | null = null;
    let settled = false;

    const onAbort = () => {
      settle(() => reject(abortError(signal)));
    };

    const settle = (complete: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      channel?.port1.close();
      channel?.port2.close();
      complete();
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    // workers-types v5 no longer declares MessageChannel on typeof globalThis;
    // the runtime capability probe is unchanged.
    if (typeof (globalThis as { MessageChannel?: unknown }).MessageChannel === "function") {
      const messageChannel = new MessageChannel();
      channel = messageChannel;
      messageChannel.port1.onmessage = () => settle(resolve);
      messageChannel.port2.postMessage(undefined);
    } else {
      queueMicrotask(() => settle(resolve));
    }
  });

  throwIfAborted(signal);
}
