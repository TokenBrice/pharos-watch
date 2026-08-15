export interface PollingWindow {
  staleTime: number;
  refetchInterval: number;
}

export function getPollingWindow(producerIntervalMs: number): PollingWindow {
  return {
    staleTime: producerIntervalMs,
    refetchInterval: 2 * producerIntervalMs,
  };
}
