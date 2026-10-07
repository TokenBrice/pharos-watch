import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { loadSchedulerLiveness, schedulerLivenessWarnings } from "../status/scheduler-liveness";
import { evaluateSchedulerLiveness } from "../status/evaluation-rules";
import { SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";
import { CRON_SCHEDULE_CADENCES } from "@shared/lib/cron-cadences";

const now = 1_791_321_600;
function slotDb(age: number, overrides: Record<string, unknown> = {}) {
  return mockD1([{ match: "AS last_any", rows: [], first: {
    last_any: now - age, reserve: now - age, telegram: now - age, digest: now - age, heavy: now - 30, ...overrides,
  } }]);
}

describe("live scheduled delivery", () => {
  it("queries actual starts for the fastest registry-owned heavy plan", async () => {
    const db = slotDb(30);
    const observation = await loadSchedulerLiveness(db, now);
    const plan = SCHEDULED_SLOT_PLANS[observation.heavy.scheduleKey as keyof typeof SCHEDULED_SLOT_PLANS];
    expect(plan.worker).toBe("heavy");
    expect(CRON_SCHEDULE_CADENCES[plan.scheduleKey].intervalSec).toBe(
      Math.min(...Object.values(SCHEDULED_SLOT_PLANS).filter((candidate) => candidate.worker === "heavy")
        .map((candidate) => CRON_SCHEDULE_CADENCES[candidate.scheduleKey].intervalSec)),
    );
    const query = db.getHistory()[0];
    expect(query.binds).toEqual(["fiveMinuteReserveRecovery", "fiveMinuteTelegramAlerts", "digestTriggerPoll", plan.scheduleKey]);
    expect(query.sql).toContain("MAX(started_at)");
    expect(query.sql).not.toContain("scheduled_at");
    expect(query.sql).not.toContain("cron_runs");
  });
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
  it.each([[1800, "healthy"], [1801, "degraded"], [2700, "degraded"], [2701, "stale"]] as const)(
    "classifies heavy delivery strictly at %ss without altering public delivery", async (age, status) => {
      const observation = await loadSchedulerLiveness(slotDb(30, { heavy: now - age }), now);
      expect(observation.status).toBe("healthy");
      expect(observation.heavy).toEqual({
        scheduleKey: "v9SupplyAttributionOffset", lastStartedAt: now - age, ageSeconds: age,
        warningAfterSec: 1800, staleAfterSec: 2700, status, unavailableReason: null,
      });
      expect(evaluateSchedulerLiveness(observation).status).toBe(status);
      expect(schedulerLivenessWarnings(observation)).toEqual(status === "healthy" ? [] : ["heavy_scheduled_delivery_stalled"]);
    },
  );
  it.each([null, 0, now + 1, Number.NaN])("keeps missing/invalid heavy clocks unavailable (%s)", async (heavy) => {
    const observation = await loadSchedulerLiveness(slotDb(30, { heavy }), now);
    expect(observation.status).toBe("healthy");
    expect(observation.heavy).toMatchObject({ status: "unavailable", ageSeconds: null,
      unavailableReason: heavy == null ? "heavy-slot-start-evidence-missing" : "slot-start-clock-invalid" });
    expect(schedulerLivenessWarnings(observation)).toEqual(["heavy_scheduler_liveness_unavailable"]);
    expect(evaluateSchedulerLiveness(observation)).toMatchObject({ status: "degraded",
      causes: [{ code: "heavy_scheduler_liveness_unavailable", threshold: 1800 }] });
  });
  it("retains both role failures when the shared query fails", async () => {
    const observation = await loadSchedulerLiveness(mockD1([{ match: "AS last_any", rows: [], throwError: new Error("unreadable") }]), now);
    expect(observation.heavy).toMatchObject({ status: "unavailable", unavailableReason: "slot-start-query-failed" });
    expect(schedulerLivenessWarnings(observation)).toEqual(["scheduler_liveness_unavailable", "heavy_scheduler_liveness_unavailable"]);
  });
});
