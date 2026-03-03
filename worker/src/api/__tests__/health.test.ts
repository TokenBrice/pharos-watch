import { describe, it, expect } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { handleHealth } from "../health";

describe("handleHealth", () => {
  it("returns 200 with health status", async () => {
    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "mint_burn_hourly", rows: [], first: { total: 1234 } },
    ]);
    const res = await handleHealth(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      timestamp: number;
      caches: Record<string, unknown>;
      blacklist: { totalEvents: number; missingAmounts: number };
      mintBurn: { totalEvents: number };
      circuits: Record<string, unknown>;
    };
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("timestamp");
    expect(body).toHaveProperty("caches");
    expect(body).toHaveProperty("blacklist");
    expect(body).toHaveProperty("mintBurn");
    expect(body).toHaveProperty("circuits");
    expect(body.mintBurn.totalEvents).toBe(1234);
    expect(["healthy", "degraded", "stale"]).toContain(body.status);
  });

  it("returns Cache-Control: no-store", async () => {
    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "mint_burn_hourly", rows: [], first: { total: 0 } },
    ]);
    const res = await handleHealth(db);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
