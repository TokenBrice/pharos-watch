import { describe, expect, it } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import { loadSevereActiveDepegAvailabilityMap } from "../redemption-backstop-availability";

const REVIEW_DATE = "2026-04-22";

describe("loadSevereActiveDepegAvailabilityMap", () => {
  it("inherits parent severe depeg into tracked wrapper route status", async () => {
    const parentStartedAt = Math.floor(Date.UTC(2026, 3, 20) / 1000);
    const db = mockD1([
      {
        match: "FROM depeg_events",
        rows: [
          {
            stablecoin_id: "usds-sky",
            peak_deviation_bps: -3100,
            started_at: parentStartedAt,
          },
        ],
      },
    ]);

    const result = await loadSevereActiveDepegAvailabilityMap(db, REVIEW_DATE);

    const parent = result.get("usds-sky");
    expect(parent?.routeStatus).toBe("degraded");
    expect(parent?.activeDepegBps).toBe(3100);

    const variant = result.get("susds-sky");
    expect(variant?.routeStatus).toBe("degraded");
    expect(variant?.routeStatusSource).toBe("market-implied");
    expect(variant?.activeDepegBps).toBe(3100);
    expect(variant?.activeDepegStartedAt).toBe(parentStartedAt);
    expect(variant?.routeStatusReason).toContain("Parent USDS");
  });

  it("does not propagate a sub-severe parent depeg to wrappers", async () => {
    const db = mockD1([
      {
        match: "FROM depeg_events",
        rows: [
          {
            stablecoin_id: "usds-sky",
            peak_deviation_bps: -1200,
            started_at: Math.floor(Date.now() / 1000),
          },
        ],
      },
    ]);

    const result = await loadSevereActiveDepegAvailabilityMap(db, REVIEW_DATE);
    expect(result.has("usds-sky")).toBe(false);
    expect(result.has("susds-sky")).toBe(false);
  });

  it("prefers the wrapper's own direct depeg over the inherited parent entry", async () => {
    const db = mockD1([
      {
        match: "FROM depeg_events",
        rows: [
          {
            stablecoin_id: "usds-sky",
            peak_deviation_bps: -3100,
            started_at: 1_000_000,
          },
          {
            stablecoin_id: "susds-sky",
            peak_deviation_bps: -4200,
            started_at: 2_000_000,
          },
        ],
      },
    ]);

    const result = await loadSevereActiveDepegAvailabilityMap(db, REVIEW_DATE);
    const variant = result.get("susds-sky");
    expect(variant?.activeDepegBps).toBe(4200);
    expect(variant?.activeDepegStartedAt).toBe(2_000_000);
    expect(variant?.routeStatusReason).toContain("Active severe depeg");
  });
});
