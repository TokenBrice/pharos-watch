export async function forEachWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  run: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        await run(values[index]!);
      }
    }),
  );
}
