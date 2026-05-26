import { describe, expect, it, vi, afterEach } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { computeDepegResolver } from "../compute-depeg-resolver";

afterEach(() => {
  vi.useRealTimers();
});

describe("computeDepegResolver", () => {
  it("excludes terminal lifecycle events from the live DDR snapshot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 4, 26, 12, 0, 0));
    const db = mockD1([
      {
        match: "FROM depeg_events_with_provenance WHERE ended_at IS NULL",
        rows: [
          {
            id: 88045,
            stablecoin_id: "usr-resolv",
            symbol: "USR",
            peg_type: "peggedUSD",
            direction: "below",
            peak_deviation_bps: -9025,
            started_at: 1774145097,
            peg_reference: 0.99975,
          },
        ],
      },
      { match: "FROM depeg_resolver_assessments", rows: [] },
      { match: "INSERT OR REPLACE INTO cache", rows: [] },
    ]);

    const result = await computeDepegResolver(db);
    const ddrCacheWrite = db
      .getHistory()
      .find((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache") && entry.binds[0] === "depeg-resolver:snapshot");
    const payload = JSON.parse(ddrCacheWrite?.binds[1] as string).payload;

    expect(result.itemCount).toBe(0);
    expect(payload.rows).toEqual([]);
  });
});
