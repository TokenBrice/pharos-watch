export const RESERVE_ADAPTER_MAX_PARALLEL_IO = 2;

export interface AdapterIoLimiter {
  run<T>(label: string, factory: () => Promise<T>, options?: { signal?: AbortSignal }): Promise<T>;
}

interface AdapterIoQueueEntry {
  label: string;
  resolve: () => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abort?: () => void;
}

function buildAbortError(signal: AbortSignal | undefined, label: string): Error | DOMException {
  const reason = signal?.reason;
  if (reason instanceof Error || reason instanceof DOMException) return reason;
  if (typeof reason === "string") return new Error(reason);
  return new Error(`Reserve adapter I/O aborted: ${label}`);
}

function throwIfAborted(signal: AbortSignal | undefined, label: string): void {
  if (signal?.aborted) {
    throw buildAbortError(signal, label);
  }
}

export function createAdapterIoLimiter(maxParallel = RESERVE_ADAPTER_MAX_PARALLEL_IO): AdapterIoLimiter {
  const max = Math.max(1, Math.floor(maxParallel));
  let active = 0;
  const queue: AdapterIoQueueEntry[] = [];

  const release = () => {
    active -= 1;
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      if (next.signal?.aborted) {
        next.reject(buildAbortError(next.signal, next.label));
        continue;
      }
      if (next.abort) {
        next.signal?.removeEventListener("abort", next.abort);
      }
      next.resolve();
      return;
    }
  };

  const waitForSlot = (label: string, signal: AbortSignal | undefined): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const entry: AdapterIoQueueEntry = {
        label,
        resolve,
        reject,
        signal,
      };
      entry.abort = () => {
        const index = queue.indexOf(entry);
        if (index >= 0) {
          queue.splice(index, 1);
        }
        reject(buildAbortError(signal, label));
      };
      if (signal) {
        signal.addEventListener("abort", entry.abort, { once: true });
      }
      queue.push(entry);
    });

  return {
    async run<T>(label: string, factory: () => Promise<T>, options?: { signal?: AbortSignal }): Promise<T> {
      throwIfAborted(options?.signal, label);
      if (active >= max) {
        await waitForSlot(label, options?.signal);
      }

      throwIfAborted(options?.signal, label);
      active += 1;
      try {
        return await factory();
      } finally {
        release();
      }
    },
  };
}

export async function runAdapterIo<T>(
  ctx: { ioLimiter?: AdapterIoLimiter; abortSignal?: AbortSignal } | undefined,
  label: string,
  factory: () => Promise<T>,
  options?: { signal?: AbortSignal },
): Promise<T> {
  const signal = options?.signal ?? ctx?.abortSignal;
  throwIfAborted(signal, label);
  return ctx?.ioLimiter ? ctx.ioLimiter.run(label, factory, { signal }) : factory();
}
