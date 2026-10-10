import { afterEach, describe, expect, it, vi } from "vitest";
import { CORE_AGGREGATE_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/aggregate-registry";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { handleNonUsdShare } from "../non-usd-share";
import { D1_MAX_BOUND_PARAMETERS } from "../../lib/db";
import { NonUsdShareResponseSchema, type NonUsdSharePoint } from "@shared/types/market";

const fixtures = createLatestSchemaFixtureTracker();
const COIN_HISTORY_GAPS = { match: "LAG(snapshot_date)", rows: [] };
const COMPLETE_COVERAGE = { basis: "interior-gap-prior-value", total: 1, commodity: 1, fiatNonUsd: 1 };


function unix(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

const COMMODITY_PEGS = new Set(["GOLD", "SILVER"]);
const CORE_IDS = CORE_AGGREGATE_ACTIVE_STABLECOINS.map((c) => c.id);
const COMMODITY_IDS = CORE_AGGREGATE_ACTIVE_STABLECOINS.filter((c) => COMMODITY_PEGS.has(c.flags.pegCurrency)).map(
  (c) => c.id,
);
const FIAT_NON_USD_IDS = CORE_AGGREGATE_ACTIVE_STABLECOINS.filter(
  (c) => c.flags.pegCurrency !== "USD" && !COMMODITY_PEGS.has(c.flags.pegCurrency),
).map((c) => c.id);
const USD_IDS = CORE_AGGREGATE_ACTIVE_STABLECOINS.filter((c) => c.flags.pegCurrency === "USD").map((c) => c.id);

describe("handleNonUsdShare", () => {
  afterEach(() => {
    fixtures.closeAll();
    vi.restoreAllMocks();
  });

  it("rejects malformed and out-of-range day windows instead of defaulting or clamping", async () => {
    for (const days of ["nope", "0", "29", "5001"]) {
      const res = await handleNonUsdShare(
        mockD1([]),
        new URL(`https://example.com/api/non-usd-share?days=${days}`),
      );
      expect(res.status, days).toBe(400);
    }
  });

  it.each(["commodity", "fiat_non_usd"])("rejects a missing %s cohort instead of publishing a zero share", async (field) => {
    const db = mockD1([
      { match: "FROM cache", rows: [] },
      COIN_HISTORY_GAPS,
      { match: "FROM supply_history", rows: [
        { snapshot_date: Math.floor(Date.now() / 1000), total: 100, commodity: 0, fiat_non_usd: 0, [field]: null },
      ] },
    ]);
    const response = await handleNonUsdShare(db, new URL("https://example.com/api/non-usd-share"));
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Non-USD share data is unavailable" });
  });

  it("preserves an observed zero cohort in the public schema", async () => {
    const date = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "FROM cache", rows: [] },
      COIN_HISTORY_GAPS,
      { match: "FROM supply_history", rows: [
        { snapshot_date: date, total: 100, commodity: 0, fiat_non_usd: 0 },
      ] },
    ]);
    const response = await handleNonUsdShare(db, new URL("https://example.com/api/non-usd-share"));
    expect(NonUsdShareResponseSchema.parse(await response.json())).toEqual([
      { date, total: 100, commodity: 0, fiatNonUsd: 0, commodityShare: 0, fiatNonUsdShare: 0, coverage: COMPLETE_COVERAGE },
    ]);
  });

  it("carries admitted partial cohort value coverage without changing the suppression floors", async () => {
    const date = Math.floor(Date.now() / 1000) - 86400;
    const db = mockD1([
      { match: "FROM cache", rows: [] },
      { match: "LAG(snapshot_date)", rows: [
        { stablecoin_id: COMMODITY_IDS[0], previous_date: date - 86400, next_date: date + 86400, previous_usd: 10 },
        { stablecoin_id: FIAT_NON_USD_IDS[0], previous_date: date - 86400, next_date: date + 86400, previous_usd: 15 },
      ] },
      { match: "FROM supply_history", rows: [
        { snapshot_date: date, total: 990, commodity: 10, fiat_non_usd: 15 },
      ] },
    ]);
    const response = await handleNonUsdShare(db, new URL("https://example.com/api/non-usd-share"));
    const body = NonUsdShareResponseSchema.parse(await response.json());
    expect(body).toHaveLength(1);
    expect(body[0].coverage).toEqual({
      basis: "interior-gap-prior-value", total: 990 / 1015, commodity: 0.5, fiatNonUsd: 0.5,
    });
    expect(body[0].commodityShare).toBe(1.0101);
  });

  it("requests the default long-range window and returns split non-USD shares within D1 bind limits", async () => {
    const nowMs = Date.UTC(2026, 3, 8, 12, 0, 0);
    const cutoff = Math.floor(nowMs / 1000) - 5000 * 86400;
    const completedSnapshotDate = unix("2026-04-07T00:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(nowMs);

    const db = mockD1(
      [
        {
          match: "FROM cache",
          matchBinds: ["snapshot-supply:last-write"],
          rows: [
            {
              key: "snapshot-supply:last-write",
              value: JSON.stringify({ snapshotDate: completedSnapshotDate }),
              updated_at: Math.floor(nowMs / 1000) - 600,
            },
          ],
          first: {
            key: "snapshot-supply:last-write",
            value: JSON.stringify({ snapshotDate: completedSnapshotDate }),
            updated_at: Math.floor(nowMs / 1000) - 600,
          },
        },
        COIN_HISTORY_GAPS,
        {
          match: "FROM supply_history",
          matchBinds: [
            JSON.stringify(CORE_IDS),
            JSON.stringify(COMMODITY_IDS),
            JSON.stringify(FIAT_NON_USD_IDS),
            cutoff,
            completedSnapshotDate,
          ],
          rows: [
            {
              snapshot_date: unix("2021-04-10T00:00:00Z"),
              total: 64_785_915_681.46,
              commodity: 1_873_999_608.17,
              fiat_non_usd: 132_274_790.42,
            },
            {
              snapshot_date: unix("2024-06-04T00:00:00Z"),
              total: 162_264_669_603.31,
              commodity: 2_812_795_250.77,
              fiat_non_usd: 352_546_495.83,
            },
            {
              snapshot_date: unix("2026-04-07T00:00:00Z"),
              total: 327_905_730_184.74,
              commodity: 5_936_875_143.74,
              fiat_non_usd: 1_826_608_786.57,
            },
          ],
        },
      ],
      { requireMatch: true },
    );

    const res = await handleNonUsdShare(db, new URL("https://example.com/api/non-usd-share"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBeTruthy();
    expect(res.headers.get("X-Data-Age")).toBe("600");
    expect(
      db
        .getHistory()
        .filter((entry) => entry.sql.includes("FROM supply_history"))
        .every((entry) => entry.binds.length <= D1_MAX_BOUND_PARAMETERS),
    ).toBe(true);

    const body = (await res.json()) as NonUsdSharePoint[];
    expect(body).toEqual([
      {
        date: unix("2021-04-10T00:00:00Z"),
        commodityShare: 2.8926,
        fiatNonUsdShare: 0.2042,
        commodity: 1_873_999_608.17,
        fiatNonUsd: 132_274_790.42,
        total: 64_785_915_681.46,
        coverage: COMPLETE_COVERAGE,
      },
      {
        date: unix("2024-06-04T00:00:00Z"),
        commodityShare: 1.7335,
        fiatNonUsdShare: 0.2173,
        commodity: 2_812_795_250.77,
        fiatNonUsd: 352_546_495.83,
        total: 162_264_669_603.31,
        coverage: COMPLETE_COVERAGE,
      },
      {
        date: unix("2026-04-07T00:00:00Z"),
        commodityShare: 1.8105,
        fiatNonUsdShare: 0.5571,
        commodity: 5_936_875_143.74,
        fiatNonUsd: 1_826_608_786.57,
        total: 327_905_730_184.74,
        coverage: COMPLETE_COVERAGE,
      },
    ]);
    db.assertAllMatchesUsed();
  });

  it("downsamples older monthly, mid-range weekly, and recent daily points", async () => {
    const nowMs = Date.UTC(2026, 3, 8, 12, 0, 0);
    const cutoff = Math.floor(nowMs / 1000) - 5000 * 86400;
    const completedSnapshotDate = unix("2026-04-08T00:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(nowMs);

    const db = mockD1(
      [
        {
          match: "FROM cache",
          matchBinds: ["snapshot-supply:last-write"],
          rows: [
            {
              key: "snapshot-supply:last-write",
              value: JSON.stringify({ snapshotDate: completedSnapshotDate }),
              updated_at: unix("2026-04-08T08:00:00Z"),
            },
          ],
          first: {
            key: "snapshot-supply:last-write",
            value: JSON.stringify({ snapshotDate: completedSnapshotDate }),
            updated_at: unix("2026-04-08T08:00:00Z"),
          },
        },
        COIN_HISTORY_GAPS,
        {
          match: "FROM supply_history",
          matchBinds: [
            JSON.stringify(CORE_IDS),
            JSON.stringify(COMMODITY_IDS),
            JSON.stringify(FIAT_NON_USD_IDS),
            cutoff,
            completedSnapshotDate,
          ],
          rows: [
            { snapshot_date: unix("2023-01-01T00:00:00Z"), total: 100, commodity: 10, fiat_non_usd: 5 },
            { snapshot_date: unix("2023-01-20T00:00:00Z"), total: 100, commodity: 11, fiat_non_usd: 5 },
            { snapshot_date: unix("2024-12-01T00:00:00Z"), total: 100, commodity: 12, fiat_non_usd: 5 },
            { snapshot_date: unix("2024-12-05T00:00:00Z"), total: 100, commodity: 13, fiat_non_usd: 5 },
            { snapshot_date: unix("2026-04-01T00:00:00Z"), total: 100, commodity: 14, fiat_non_usd: 5 },
            { snapshot_date: unix("2026-04-01T12:00:00Z"), total: 100, commodity: 15, fiat_non_usd: 5 },
          ],
        },
      ],
      { requireMatch: true },
    );

    const res = await handleNonUsdShare(db, new URL("https://example.com/api/non-usd-share?days=5000"));
    const body = (await res.json()) as NonUsdSharePoint[];

    expect(body.map((point) => point.date)).toEqual([
      unix("2023-01-01T00:00:00Z"),
      unix("2024-12-01T00:00:00Z"),
      unix("2026-04-01T00:00:00Z"),
    ]);
    expect(body.map((point) => point.commodityShare + point.fiatNonUsdShare)).toEqual([15, 17, 19]);
    db.assertAllMatchesUsed();
  });

  describe("partial snapshot days", () => {
    const [largeUsdId, smallUsdId] = USD_IDS;
    const commodityId = COMMODITY_IDS[0]!;
    const fiatId = FIAT_NON_USD_IDS[0]!;
    const completeDay: Record<string, number> = {
      [largeUsdId!]: 940,
      [smallUsdId!]: 10,
      [commodityId]: 20,
      [fiatId]: 30,
    };
    const before = unix("2026-08-05T00:00:00Z");
    const partial = unix("2026-08-06T00:00:00Z");
    const after = unix("2026-08-07T00:00:00Z");

    it("omits the first window date when a dominant asset's predecessor is before cutoff", async () => {
      vi.spyOn(Date, "now").mockReturnValue((before + 30 * 86400 + 12 * 3600) * 1000);
      const { db, sqlite } = fixtures.open();
      const insert = sqlite.prepare("INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, 1)");
      for (const date of [before, partial, after]) {
        for (const [id, value] of Object.entries(completeDay)) {
          if (date === partial && id === largeUsdId) continue;
          insert.run(id, date, value);
        }
      }
      const response = await handleNonUsdShare(db, new URL("https://example.com/api/non-usd-share?days=30"));
      const body = NonUsdShareResponseSchema.parse(await response.json());
      expect(body.map(point => point.date)).toEqual([after]);
      expect(body[0]!.total).toBe(1000);
    });

    it.each([
      { name: "a small asset's hole", missing: [smallUsdId!], published: true },
      { name: "every asset but one small row", missing: [largeUsdId!, commodityId, fiatId], published: false },
      { name: "the dominant asset", missing: [largeUsdId!], published: false },
      { name: "a whole commodity cohort", missing: [commodityId], published: false },
      { name: "a whole fiat non-USD cohort", missing: [fiatId], published: false },
    ])("publishes a day missing $name only while coverage floors hold", async ({ missing, published }) => {
      vi.spyOn(Date, "now").mockReturnValue((after + 12 * 3600) * 1000);
      const { db, sqlite } = fixtures.open();
      const insert = sqlite.prepare(
        "INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, 1)",
      );
      for (const date of [before, partial, after]) {
        for (const [stablecoinId, circulatingUsd] of Object.entries(completeDay)) {
          if (date === partial && missing.includes(stablecoinId)) continue;
          insert.run(stablecoinId, date, circulatingUsd);
        }
      }

      const response = await handleNonUsdShare(db, new URL("https://example.com/api/non-usd-share"));
      const body = NonUsdShareResponseSchema.parse(await response.json());

      expect(body.map((point) => point.date)).toEqual(published ? [before, partial, after] : [before, after]);
      if (published) expect(body.find((point) => point.date === partial)?.coverage).toEqual({
        basis: "interior-gap-prior-value", total: 0.99, commodity: 1, fiatNonUsd: 1,
      });
      expect(body.find((point) => point.date === before)).toEqual({
        date: before,
        total: 1000,
        commodity: 20,
        fiatNonUsd: 30,
        commodityShare: 2,
        fiatNonUsdShare: 3,
        coverage: COMPLETE_COVERAGE,
      });
    });
  });
});
