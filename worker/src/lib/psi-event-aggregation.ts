export function includePsiEventDeviation(
  aggregate: { worstBps: number; earliestStart: number },
  bps: number,
  startedAt: number,
): void {
  if (Math.abs(bps) > Math.abs(aggregate.worstBps)) aggregate.worstBps = bps;
  if (startedAt < aggregate.earliestStart) aggregate.earliestStart = startedAt;
}
