import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { recordSiteDataRequest, resetSiteDataRequestAttributionStateForTests } from "../request-attribution";

const fixtures = createLatestSchemaFixtureTracker();
const route = { routeKey: "stablecoins", routePath: "/api/stablecoins" };
const minute = 1_700_000_040;

beforeEach(() => {
  vi.useFakeTimers();
  resetSiteDataRequestAttributionStateForTests();
});
afterEach(() => {
  resetSiteDataRequestAttributionStateForTests();
  fixtures.closeAll();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("sampled Pages attribution writer", () => {
  it("does no SQL or timer work for an unselected ordinary delivery", async () => {
    const { db } = fixtures.open();
    const prepare = vi.spyOn(db, "prepare");
    vi.spyOn(Math, "random").mockReturnValue(1 / 64);
    await recordSiteDataRequest(db, route, "pages-upstream-fetch", "site-api", minute);
    expect(prepare).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("merges only selected events and stores certainty failures with their own rate", async () => {
    const { db, sqlite } = fixtures.open();
    const draw = vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0.9).mockReturnValueOnce(0);
    const pending = [
      recordSiteDataRequest(db, route, "pages-upstream-fetch", "site-api", minute),
      recordSiteDataRequest(db, route, "pages-upstream-fetch", "site-api", minute),
      recordSiteDataRequest(db, route, "pages-upstream-fetch", "site-api", minute),
      recordSiteDataRequest(db, route, "pages-upstream-timeout", "site-api", minute),
      recordSiteDataRequest(db, route, "pages-upstream-error", "site-api", minute),
    ];
    await vi.runAllTimersAsync();
    await Promise.all(pending);
    expect(draw).toHaveBeenCalledTimes(3);
    expect(sqlite.prepare(`SELECT delivery_path, sample_inverse_rate, sample_count
      FROM site_data_request_samples ORDER BY delivery_path`).all()).toEqual([
      { delivery_path: "pages-upstream-error", sample_inverse_rate: 1, sample_count: 1 },
      { delivery_path: "pages-upstream-fetch", sample_inverse_rate: 64, sample_count: 2 },
      { delivery_path: "pages-upstream-timeout", sample_inverse_rate: 1, sample_count: 1 },
    ]);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM site_data_request_stats").get()).toEqual({ count: 0 });
  });

  it("retains a failed selected chunk for one bounded retry without expanding its counts", async () => {
    const { db, sqlite } = fixtures.open();
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const batch = vi.spyOn(db, "batch").mockRejectedValueOnce(new Error("D1 unavailable"));
    const pending = recordSiteDataRequest(db, route, "pages-upstream-fetch", "site-api", minute);
    await vi.runAllTimersAsync();
    await pending;
    expect(batch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(sqlite.prepare("SELECT sample_inverse_rate, sample_count FROM site_data_request_samples").all())
      .toEqual([{ sample_inverse_rate: 64, sample_count: 1 }]);
  });
});
