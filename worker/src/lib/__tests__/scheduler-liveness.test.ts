import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { loadSchedulerLiveness } from "../status/scheduler-liveness";
import { evaluateSchedulerLiveness } from "../status/evaluation-rules";

const now = 1_791_321_600;
function slotDb(age: number, overrides: Record<string, unknown> = {}) {
  return mockD1([{ match: "AS last_any", rows: [], first: {
    last_any: now - age, reserve: now - age, telegram: now - age, digest: now - age, ...overrides,
  } }]);
}

describe("live scheduled delivery", () => {
  it.each([[600, "healthy"], [601, "degraded"], [1200, "degraded"], [1201, "stale"]] as const)(
    "classifies strictly at %ss", async (age, status) => {
      const observation = await loadSchedulerLiveness(slotDb(age), now);
      expect(observation).toMatchObject({ status, ageSeconds: age, observedAt: now, warningAfterSec: 600, staleAfterSec: 1200 });
      expect(evaluateSchedulerLiveness(observation).status).toBe(status);
    },
  );
  it("does not let hourly delivery mask five-minute loss", async () => {
    expect(await loadSchedulerLiveness(slotDb(1201, { last_any: now - 1 }), now)).toMatchObject({ status: "stale", lastAnyStartedAt: now - 1 });
  });
  it("retains partial lane loss as diagnostic while a canonical lane delivers", async () => {
    const observation = await loadSchedulerLiveness(slotDb(1201, { last_any: now - 1, digest: now - 1, telegram: null }), now);
    expect(observation.status).toBe("healthy");
    expect(observation.lanes[1].lastStartedAt).toBeNull();
  });
  it.each([
    { last_any: null, reserve: null, telegram: null, digest: null },
    { reserve: null, telegram: null, digest: null },
    { reserve: now + 1 }, { last_any: now + 1 }, { reserve: 0 },
  ])("fails closed on missing/invalid clocks %j", async (overrides) => {
    const observation = await loadSchedulerLiveness(slotDb(30, overrides), now);
    expect(observation.status).toBe("unavailable");
    expect(evaluateSchedulerLiveness(observation)).toMatchObject({ status: "degraded", causes: [{ code: "scheduler_liveness_unavailable" }] });
  });
  it("does not turn a failed read into healthy delivery", async () => {
    const db = mockD1([{ match: "AS last_any", rows: [], throwError: new Error("unreadable") }]);
    expect(await loadSchedulerLiveness(db, now)).toMatchObject({ status: "unavailable", ageSeconds: null, unavailableReason: "slot-start-query-failed" });
  });
});
