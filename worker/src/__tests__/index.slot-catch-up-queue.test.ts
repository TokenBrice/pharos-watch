import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../lib/env";
import worker from "../index";

const state = vi.hoisted(() => ({
  scheduled: vi.fn(async () => undefined),
  reserve: vi.fn(async () => undefined),
  clock: 1_000,
}));
vi.mock("../handlers/scheduled", () => ({ handleScheduledEvent: state.scheduled }));
vi.mock("../handlers/reserve-continuation", () => {
  // Model lazy module initialization consuming event wall time.
  state.clock = 4_000;
  return { handleReserveContinuationBatch: state.reserve };
});

// 2027-01-14T08:55:00Z two-hourly yield slot, delivered ten minutes later.
const SLOT = 1_799_916_900;

function batchOf(body: unknown) {
  const message = { id: "m1", attempts: 1, timestamp: new Date(), body, ack: vi.fn(), retry: vi.fn() };
  return { queue: "pharos-reserve-continuation", messages: [message], ackAll: vi.fn(), retryAll: vi.fn() } as unknown as
    MessageBatch<unknown> & { ackAll: ReturnType<typeof vi.fn> };
}

const message = {
  version: 1, kind: "slot-catch-up", scheduleKey: "hourlyYieldSync", slotStartedAt: SLOT,
  trigger: "abandoned", armedAt: SLOT + 600, armedByInvocationId: "digest-poll",
};
const env = { WORKER_SLOT_CATCH_UP_MODE: "on" } as Env;
const ctx = {} as ExecutionContext;

describe("slot catch-up Queue consumer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    state.scheduled.mockClear();
    state.reserve.mockClear();
  });

  // Must precede the case that imports the reserve-continuation module: the
  // queue deadline is only observable while that graph is still unloaded.
  it("captures the Queue deadline clock before loading the consumer graph", async () => {
    vi.spyOn(Date, "now").mockImplementation(() => state.clock);
    const batch = { queue: "pharos-reserve-continuation", messages: [] } as unknown as MessageBatch<unknown>;
    await worker.queue(batch, {} as Env, ctx);
    expect(state.reserve).toHaveBeenCalledExactlyOnceWith(batch, {} as Env, ctx, 1_000);
    expect(state.clock).toBe(4_000);
  });

  it("runs the armed slot under its own schedule identity and acknowledges it once", async () => {
    vi.spyOn(Date, "now").mockReturnValue((SLOT + 610) * 1000);
    const batch = batchOf(message);
    await worker.queue(batch, env, ctx);
    expect(batch.ackAll).toHaveBeenCalledTimes(1);
    expect(state.reserve).not.toHaveBeenCalled();
    expect(state.scheduled).toHaveBeenCalledExactlyOnceWith(
      { cron: "55 */2 * * *", scheduledTime: SLOT * 1000 }, env, ctx, "public", expect.any(Object), (SLOT + 610) * 1000,
      { trigger: "abandoned", armedAt: SLOT + 600, armedByInvocationId: "digest-poll" },
      (SLOT + 610 + 12 * 60) * 1000,
    );
  });

  it.each([
    // [lane, slot, dispatched trigger, lane timeout in minutes]; the slot comes
    // from scheduledTime, so a paired hourly lane always dispatches its first alias.
    ["halfHourlyMintBurnCritical", SLOT + 39 * 60, "4 * * * *", 10],
    ["dewsPsiOffset", SLOT + 31 * 60, "26,56 * * * *", 5],
    ["twoHourlyDexDiscovery", SLOT - 2 * 3600 - 49 * 60, "6 */6 * * *", 13],
  ] as const)("runs an armed %s slot bounded by its lane timeout", async (scheduleKey, slot, cron, timeoutMin) => {
    const entryMs = (slot + 600) * 1000;
    vi.spyOn(Date, "now").mockReturnValue(entryMs);
    const batch = batchOf({ ...message, scheduleKey, slotStartedAt: slot, armedAt: slot + 600 });
    await worker.queue(batch, env, ctx);
    expect(batch.ackAll).toHaveBeenCalledTimes(1);
    expect(state.scheduled).toHaveBeenCalledExactlyOnceWith(
      { cron, scheduledTime: slot * 1000 }, env, ctx, "public", expect.any(Object), entryMs,
      { trigger: "abandoned", armedAt: slot + 600, armedByInvocationId: "digest-poll" },
      entryMs + timeoutMin * 60_000,
    );
  });

  it.each([
    ["mode off", { ...message }, { WORKER_SLOT_CATCH_UP_MODE: "off" } as Env, SLOT + 610],
    ["next natural slot imminent", { ...message }, env, SLOT + 106 * 60],
    ["lane not opted in", { ...message, scheduleKey: "statusSelfCheckOffset" }, env, SLOT + 610],
    ["malformed hint", { ...message, extra: true }, env, SLOT + 610],
  ])("acknowledges without running when %s", async (_label, body, runtimeEnv, nowSec) => {
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    const batch = batchOf(body);
    await worker.queue(batch, runtimeEnv, ctx);
    expect(batch.ackAll).toHaveBeenCalledTimes(1);
    expect(state.scheduled).not.toHaveBeenCalled();
    expect(state.reserve).not.toHaveBeenCalled();
  });

  it("leaves reserve continuation hints to the reserve consumer", async () => {
    const batch = batchOf({ version: 1, scheduleKey: "fourHourlyReserveSync" });
    await worker.queue(batch, env, ctx);
    expect(state.reserve).toHaveBeenCalledTimes(1);
    expect(state.scheduled).not.toHaveBeenCalled();
  });
});
