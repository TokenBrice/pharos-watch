import { throwIfAborted } from "../../lib/abort";

export interface BoundedQueueProgress<TItem, TResult> {
  completed: number;
  total: number;
  inFlight: number;
  item: TItem;
  result: TResult;
}

export interface RunBoundedQueueOptions<TItem, TResult> {
  items: readonly TItem[];
  concurrency: number;
  signal?: AbortSignal;
  worker: (item: TItem, index: number) => Promise<TResult>;
  onProgress?: (progress: BoundedQueueProgress<TItem, TResult>) => Promise<void> | void;
}

export async function runBoundedQueue<TItem, TResult>({
  items,
  concurrency,
  signal,
  worker,
  onProgress,
}: RunBoundedQueueOptions<TItem, TResult>): Promise<TResult[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`runBoundedQueue concurrency must be a positive integer; received ${concurrency}`);
  }

  throwIfAborted(signal);

  const results = new Array<TResult>(items.length);
  let nextIndex = 0;
  let completed = 0;
  let inFlight = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      throwIfAborted(signal);
      const index = nextIndex;
      if (index >= items.length) return;
      nextIndex += 1;
      inFlight += 1;

      try {
        const result = await worker(items[index], index);
        results[index] = result;
        completed += 1;
        await onProgress?.({
          completed,
          total: items.length,
          inFlight: Math.max(0, inFlight - 1),
          item: items[index],
          result,
        });
      } finally {
        inFlight -= 1;
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}
