import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../lib/env";
import worker from "../index";

const state = vi.hoisted(() => ({
  scheduled: vi.fn(async () => undefined),
  reserve: vi.fn(async () => undefined),
}));
vi.mock("../handlers/scheduled", () => ({ handleScheduledEvent: state.scheduled }));
vi.mock("../handlers/reserve-continuation", () => ({ handleReserveContinuationBatch: state.reserve }));

// 2027-01-14T09:55:00Z hourly yield slot, delivered ten minutes later.
const SLOT = 1_799_920_500;

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

  it("runs the armed slot under its own schedule identity and acknowledges it once", async () => {
    vi.spyOn(Date, "now").mockReturnValue((SLOT + 610) * 1000);
    const batch = batchOf(message);
    await worker.queue(batch, env, ctx);
    expect(batch.ackAll).toHaveBeenCalledTimes(1);
    expect(state.reserve).not.toHaveBeenCalled();
    expect(state.scheduled).toHaveBeenCalledExactlyOnceWith(
      { cron: "55 * * * *", scheduledTime: SLOT * 1000 }, env, ctx, "public", expect.any(Object), (SLOT + 610) * 1000,
      { trigger: "abandoned", armedAt: SLOT + 600, armedByInvocationId: "digest-poll" },
    );
  });

  it.each([
    ["mode off", { ...message }, { WORKER_SLOT_CATCH_UP_MODE: "off" } as Env, SLOT + 610],
    ["next natural slot imminent", { ...message }, env, SLOT + 46 * 60],
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
