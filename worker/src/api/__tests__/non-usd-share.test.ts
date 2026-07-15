import { afterEach, describe, expect, it, vi } from "vitest";
import { CORE_AGGREGATE_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/aggregate-registry";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { handleNonUsdShare } from "../non-usd-share";
import { D1_MAX_BOUND_PARAMETERS } from "../../lib/db";

interface NonUsdSharePoint {
  date: number;
  commodityShare: number;
  fiatNonUsdShare: number;
  commodity: number;
  fiatNonUsd: number;
  total: number;
}

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

describe("handleNonUsdShare", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
      },
      {
        date: unix("2024-06-04T00:00:00Z"),
        commodityShare: 1.7335,
        fiatNonUsdShare: 0.2173,
        commodity: 2_812_795_250.77,
        fiatNonUsd: 352_546_495.83,
        total: 162_264_669_603.31,
      },
      {
        date: unix("2026-04-07T00:00:00Z"),
        commodityShare: 1.8105,
        fiatNonUsdShare: 0.5571,
        commodity: 5_936_875_143.74,
        fiatNonUsd: 1_826_608_786.57,
        total: 327_905_730_184.74,
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
});
