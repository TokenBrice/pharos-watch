import { describe, expect, it, vi } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "./helpers/auth";

vi.mock("../../lib/dews", () => ({
  computeDEWS: vi.fn(() => ({
    score: 67,
    band: "WARNING",
    signals: {},
  })),
}));

import { computeDEWS } from "../../lib/dews";
import { handleBackfillDEWS } from "../backfill-dews";

stubCryptoForAuth();

describe("handleBackfillDEWS", () => {
  it("reconstructs inputs from circulating_usd and liquidity history schema columns", async () => {
    const startedAt = 1710000000;
    const day = Math.floor(startedAt / 86400) * 86400;
    const db = mockD1([
      {
        match: "FROM depeg_events",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            started_at: startedAt,
            ended_at: startedAt + 7200,
            peak_deviation_bps: -150,
          },
        ],
      },
      {
        match: "FROM supply_history",
        rows: [
          { stablecoin_id: "usdt-tether", snapshot_date: day, circulating_usd: 100_000_000 },
          { stablecoin_id: "usdt-tether", snapshot_date: day - 86400, circulating_usd: 99_500_000 },
          { stablecoin_id: "usdt-tether", snapshot_date: day - 7 * 86400, circulating_usd: 98_000_000 },
        ],
      },
      {
        match: "FROM dex_liquidity_history",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            snapshot_date: day,
            liquidity_score: 81,
            total_tvl_usd: 2_200_000,
          },
          {
            stablecoin_id: "usdt-tether",
            snapshot_date: day - 7 * 86400,
            liquidity_score: 77,
            total_tvl_usd: 2_000_000,
          },
        ],
      },
    ]);

    const request = makeApiRequest("/api/backfill-dews", { adminKey: "secret" });
    const response = await handleBackfillDEWS(
      db,
      makeApiUrl("/api/backfill-dews"),
      true,
      request,
    );

    expect(response.status).toBe(200);
    expect(computeDEWS).toHaveBeenCalledWith(
      expect.objectContaining({
        stablecoinId: "usdt-tether",
        circulatingCurrent: 100_000_000,
        circulatingPrevDay: 99_500_000,
        circulatingPrevWeek: 98_000_000,
        liquidityScore: 81,
        liquidityScore7dAgo: 77,
        tvlCurrent: 2_200_000,
        tvl7dAgo: 2_000_000,
      }),
    );
  });
});
