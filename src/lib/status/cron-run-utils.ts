export function countConsecutiveStatus(runs: readonly { status: string }[], status: string): number {
  let count = 0;
  for (const run of runs) {
    if (run.status !== status) break;
    count += 1;
  }
  return count;
}

export function getLastSuccessfulRun<T extends { status: string }>(runs: readonly T[]): T | null {
  return runs.find((run) => run.status === "ok" || run.status === "degraded") ?? null;
}
