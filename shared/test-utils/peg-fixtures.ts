export type TestPegEvent = {
  startedAt: number;
  endedAt: number | null;
  peakDeviationBps: number;
};

export function makePegEvent(
  overrides: Partial<TestPegEvent> & Pick<TestPegEvent, "startedAt" | "peakDeviationBps">,
): TestPegEvent {
  return {
    endedAt: null,
    ...overrides,
  };
}
