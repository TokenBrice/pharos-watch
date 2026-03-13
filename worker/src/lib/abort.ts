export function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === "string" && reason.length > 0) return new Error(reason);
  return new Error("Operation aborted");
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
