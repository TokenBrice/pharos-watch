import { describe, expect, it } from "vitest";
import { API_CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { addFreshnessHeaders } from "../api-freshness-headers";

const assessedAt = 1_800_000_000;

function directive(headers: Record<string, string>, name: string): number {
  const entry = headers["Cache-Control"].split(",").map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return Number(entry?.slice(name.length + 1));
}

describe("freshness cache runway", () => {
  it.each([
    ["generic", 600, 4_800],
    ["chains", 1_800, 1_800],
    ["yield", 3_600, 7_200],
  ])("bounds %s shared, browser and revalidation windows by the route's fresh boundary", (_, maxAgeSec, freshBudgetSec) => {
    for (const profile of [API_CACHE_PROFILES.standard, API_CACHE_PROFILES.producerBacked]) {
      const headers = addFreshnessHeaders({ "Cache-Control": profile }, assessedAt - freshBudgetSec + 10, maxAgeSec, {
        assessedAt, freshBudgetSec,
      });
      expect(directive(headers, "s-maxage")).toBe(10);
      expect(directive(headers, "max-age")).toBe(10);
      expect(headers["X-Data-Updated-At"]).toBe(String(assessedAt - freshBudgetSec + 10));
      if (profile === API_CACHE_PROFILES.producerBacked) {
        expect(directive(headers, "stale-while-revalidate")).toBe(0);
      }
    }
  });

  it("does not grant SWR an independent runway beyond its base lifetime", () => {
    const headers = addFreshnessHeaders({ "Cache-Control": "public, s-maxage=60, max-age=10, stale-while-revalidate=300" }, assessedAt - 4_700, 600, { assessedAt });
    expect(directive(headers, "s-maxage") + directive(headers, "stale-while-revalidate")).toBeLessThanOrEqual(100);
    expect(directive(headers, "max-age") + directive(headers, "stale-while-revalidate")).toBeLessThanOrEqual(100);
  });

  it.each([0, -1, 0.5])("disables cache storage when only %s seconds remain", (remaining) => {
    const headers = addFreshnessHeaders({ "Cache-Control": API_CACHE_PROFILES.standard }, assessedAt - 4_800 + remaining, 600, { assessedAt });
    expect(headers["Cache-Control"]).toBe("no-store");
    expect(headers["X-Data-Updated-At"]).toBe(String(assessedAt - 4_800 + remaining));
  });

  it("preserves Age and Date rather than refreshing transport age", () => {
    const date = new Date((assessedAt - 5) * 1_000).toUTCString();
    const headers = addFreshnessHeaders({ "Cache-Control": API_CACHE_PROFILES.standard, Age: "5", Date: date }, assessedAt - 100, 600, { assessedAt });
    expect(headers.Age).toBe("5");
    expect(headers.Date).toBe(date);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])("rejects a nonfinite origin clock (%s)", (updatedAt) => {
    expect(() => addFreshnessHeaders({}, updatedAt, 600, { assessedAt })).toThrow("Freshness timestamps must be finite");
  });

  it("does not publish a negative origin clock", () => {
    expect(addFreshnessHeaders({}, -1, 600, { assessedAt })["X-Data-Updated-At"]).toBeUndefined();
  });
});
