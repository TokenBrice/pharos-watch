export const RESERVE_ADAPTER_MAX_PARALLEL_IO = 2;

export interface AdapterIoLimiter {
  run<T>(label: string, factory: () => Promise<T>): Promise<T>;
}

export function createAdapterIoLimiter(maxParallel = RESERVE_ADAPTER_MAX_PARALLEL_IO): AdapterIoLimiter {
  const max = Math.max(1, Math.floor(maxParallel));
  let active = 0;
  const queue: Array<() => void> = [];

  const release = () => {
    active -= 1;
    const next = queue.shift();
    if (next) next();
  };

  return {
    async run<T>(_label: string, factory: () => Promise<T>): Promise<T> {
      if (active >= max) {
        await new Promise<void>((resolve) => {
          queue.push(resolve);
        });
      }

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
  ctx: { ioLimiter?: AdapterIoLimiter } | undefined,
  label: string,
  factory: () => Promise<T>,
): Promise<T> {
  return ctx?.ioLimiter ? ctx.ioLimiter.run(label, factory) : factory();
}
