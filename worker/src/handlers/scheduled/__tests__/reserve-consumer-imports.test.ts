import { describe, expect, it, vi } from "vitest";

const initialized = vi.hoisted(() => ({ reserves: false, backstops: false, sentinel: false }));

vi.mock("../../../cron/sync-live-reserves", () => {
  initialized.reserves = true;
  return { syncLiveReserves: vi.fn() };
});
vi.mock("../../../cron/sync-kinesis-supply", () => ({ syncKinesisSupply: vi.fn() }));
vi.mock("../../../lib/scheduled-recovery-checkpoint", () => ({
  beginLiveReserveCheckpoint: vi.fn(),
  finishLiveReserveCheckpoint: vi.fn(),
  loadLiveReserveCheckpoint: vi.fn(),
  setLiveReserveCheckpointChildDisposition: vi.fn(),
}));
vi.mock("../../../cron/sync-redemption-backstops", () => {
  initialized.backstops = true;
  return { syncRedemptionBackstops: vi.fn() };
});
vi.mock("../../../cron/cron-sentinel", () => {
  initialized.sentinel = true;
  return { runCronSentinel: vi.fn() };
});

describe("reserve consumer module boundaries", () => {
  it("does not initialize downstream policy and sentinel graphs when loading the producer runner", async () => {
    // This test intentionally exercises module initialization, not just task calls.
    const runner = await import("../hourly-live-reserves");
    expect(runner.runFourHourlyReserveSyncSlot).toBeTypeOf("function");
    expect(initialized).toEqual({ reserves: false, backstops: false, sentinel: false });
  });
});
