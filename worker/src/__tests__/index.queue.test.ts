import { afterEach, expect, it, vi } from "vitest";
import type { Env } from "../lib/env";
import worker from "../index";

const state = vi.hoisted(() => ({ clock: 1_000, handler: vi.fn(async () => undefined) }));
vi.mock("../handlers/reserve-continuation", () => {
  // Model lazy module initialization consuming event wall time.
  state.clock = 4_000;
  return { handleReserveContinuationBatch: state.handler };
});
afterEach(() => vi.restoreAllMocks());
it("captures the Queue deadline clock before loading the consumer graph", async () => {
  vi.spyOn(Date, "now").mockImplementation(() => state.clock);
  const batch = { queue: "pharos-reserve-continuation", messages: [] } as unknown as MessageBatch<unknown>;
  const env = {} as Env;
  const ctx = {} as ExecutionContext;
  await worker.queue(batch, env, ctx);
  expect(state.handler).toHaveBeenCalledExactlyOnceWith(batch, env, ctx, 1_000);
  expect(state.clock).toBe(4_000);
});
