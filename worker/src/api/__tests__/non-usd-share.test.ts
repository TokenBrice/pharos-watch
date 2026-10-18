import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { handleNonUsdShare } from "../non-usd-share";
import { NON_USD_SHARE_HISTORY_KEY, publishNonUsdShareHistory } from "../../lib/non-usd-share-history";

const fixtures = createLatestSchemaFixtureTracker();
const DAY = 86400;
afterEach(() => { fixtures.closeAll(); vi.restoreAllMocks(); });

async function publishedFixture(age = 600) {
  const now = Math.floor(Date.now() / 1000);
  const updatedAt = now - age;
  const date = Math.floor(updatedAt / DAY) * DAY;
  const fixture = fixtures.open();
  fixture.sqlite.prepare("INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd) VALUES ('usdt-tether', ?, 100)").run(date);
  fixture.sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('snapshot-supply:last-write', ?, ?)")
    .run(JSON.stringify({ snapshotDate: date, generationId: "source-generation" }), updatedAt);
  await publishNonUsdShareHistory(fixture.db, now);
  return { ...fixture, date, updatedAt };
}

describe("handleNonUsdShare", () => {
  it("rejects invalid windows before reading any publication", async () => {
    for (const days of ["nope", "0", "29", "5001"]) {
      const db = mockD1([]);
      const response = await handleNonUsdShare(db, new URL(`https://x/api/non-usd-share?days=${days}`));
      expect(response.status).toBe(400);
      expect(db.getHistory()).toEqual([]);
    }
  });

  it("serves validated published points in one cache-only read with the original source clock", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 18, 12));
    const { db, updatedAt, date } = await publishedFixture();
    const prepare = vi.spyOn(db, "prepare");
    const response = await handleNonUsdShare(db, new URL("https://x/api/non-usd-share?days=30"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{
      date, total: 100, commodity: 0, fiatNonUsd: 0, commodityShare: 0, fiatNonUsdShare: 0,
      coverage: { basis: "interior-gap-prior-value", total: 1, commodity: 1, fiatNonUsd: 1 },
    }]);
    expect(response.headers.get("X-Data-Updated-At")).toBe(String(updatedAt));
    expect(response.headers.get("X-Data-Age")).toBe("600");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]![0]).not.toContain("supply_history");
  });

  it("serves request-time history with the original snapshot clock when publication is absent", async () => {
    const { db, sqlite, date, updatedAt } = await publishedFixture();
    sqlite.prepare("DELETE FROM cache WHERE key = ?").run(NON_USD_SHARE_HISTORY_KEY);
    const prepare = vi.spyOn(db, "prepare");
    const response = await handleNonUsdShare(db, new URL("https://x/api/non-usd-share?days=30"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{
      date, total: 100, commodity: 0, fiatNonUsd: 0, commodityShare: 0, fiatNonUsdShare: 0,
      coverage: { basis: "interior-gap-prior-value", total: 1, commodity: 1, fiatNonUsd: 1 },
    }]);
    expect(response.headers.get("X-Data-Updated-At")).toBe(String(updatedAt));
    expect(prepare.mock.calls.some(([sql]) => sql.includes("FROM supply_history"))).toBe(true);
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(NON_USD_SHARE_HISTORY_KEY)).toBeUndefined();
  });

  it("retains the legacy sampled-point clock when neither publication nor completion marker exists", async () => {
    const { db, sqlite } = fixtures.open();
    const date = Math.floor(Date.now() / 1000) - 900 * DAY;
    sqlite.prepare("INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd) VALUES ('usdt-tether', ?, 100), ('usdt-tether', ?, 110)")
      .run(date, date + 7 * DAY);
    const response = await handleNonUsdShare(db, new URL("https://x/api/non-usd-share"));
    expect(response.status).toBe(200);
    expect((await response.json() as Array<{ date: number }>).map((point) => point.date)).toEqual([date]);
    expect(response.headers.get("X-Data-Updated-At")).toBe(String(date));
    expect(response.headers.get("Warning")).toContain("110");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("preserves the previous successful empty-history contract before bootstrap", async () => {
    const { db } = fixtures.open();
    const response = await handleNonUsdShare(db, new URL("https://x/api/non-usd-share"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(response.headers.get("X-Data-Updated-At")).toBeNull();
    expect(response.headers.get("Cache-Control")).toContain("s-maxage=3600");
  });

  it.each(["malformed", "generation-changed", "cohort-changed"])("fails closed on %s publication evidence", async (kind) => {
    const { db, sqlite } = await publishedFixture();
    if (kind === "malformed") sqlite.prepare("UPDATE cache SET value = '{broken' WHERE key = ?").run(NON_USD_SHARE_HISTORY_KEY);
    if (kind === "generation-changed") sqlite.prepare("UPDATE cache SET value = ? WHERE key = 'snapshot-supply:last-write'")
      .run(JSON.stringify({ snapshotDate: 1, generationId: "replacement-at-the-same-second" }));
    if (kind === "cohort-changed") {
      const row = sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(NON_USD_SHARE_HISTORY_KEY) as { value: string };
      const payload = JSON.parse(row.value);
      payload.cohortIdentity = "old-cohort";
      sqlite.prepare("UPDATE cache SET value = ? WHERE key = ?").run(JSON.stringify(payload), NON_USD_SHARE_HISTORY_KEY);
    }
    const prepare = vi.spyOn(db, "prepare");
    const response = await handleNonUsdShare(db, new URL("https://x/api/non-usd-share"));
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ reason: "non-usd-share-publication-unavailable" });
    expect(prepare.mock.calls.every(([sql]) => !sql.includes("supply_history"))).toBe(true);
  });

  it("does not refresh an old producer timestamp when serving a retained generation", async () => {
    const { db, updatedAt } = await publishedFixture(20 * DAY);
    const response = await handleNonUsdShare(db, new URL("https://x/api/non-usd-share"));
    expect(response.headers.get("X-Data-Updated-At")).toBe(String(updatedAt));
    expect(response.headers.get("Warning")).toContain("110");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
