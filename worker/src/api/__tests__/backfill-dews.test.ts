import { describe, expect, it, vi } from "vitest";
import { mockD1 } from "./helpers/mock-d1";

vi.mock("../../lib/dews", () => ({
  computeDEWS: vi.fn(() => ({
    score: 67,
    band: "WARNING",
    signals: {},
  })),
}));

import { computeDEWS } from "../../lib/dews";
import { handleBackfillDEWS } from "../backfill-dews";

vi.stubGlobal("crypto", {
  subtle: {
    digest: async (_algo: string, data: ArrayBuffer) => data,
    timingSafeEqual: (a: ArrayBuffer, b: ArrayBuffer) => {
      const av = new Uint8Array(a);
      const bv = new Uint8Array(b);
      if (av.length !== bv.length) return false;
      return av.every((byte, i) => byte === bv[i]);
    },
  },
});

describe("handleBackfillDEWS", () => {
  it("reconstructs inputs from circulating_usd and liquidity history schema columns", async () => {
    const startedAt = 1710000000;
    const day = Math.floor(startedAt / 86400) * 86400;
    const db = mockD1([
      {
        match: "FROM depeg_events",
        rows: [
          {
            stablecoin_id: "1",
            started_at: startedAt,
            ended_at: startedAt + 7200,
            peak_deviation_bps: -150,
          },
        ],
      },
      {
        match: "FROM supply_history",
        rows: [
          { stablecoin_id: "1", snapshot_date: day, circulating_usd: 100_000_000 },
          { stablecoin_id: "1", snapshot_date: day - 86400, circulating_usd: 99_500_000 },
          { stablecoin_id: "1", snapshot_date: day - 7 * 86400, circulating_usd: 98_000_000 },
        ],
      },
      {
        match: "FROM dex_liquidity_history",
        rows: [
          {
            stablecoin_id: "1",
            snapshot_date: day,
            liquidity_score: 81,
            total_tvl_usd: 2_200_000,
          },
          {
            stablecoin_id: "1",
            snapshot_date: day - 7 * 86400,
            liquidity_score: 77,
            total_tvl_usd: 2_000_000,
          },
        ],
      },
    ]);

    const request = new Request("https://x/api/backfill-dews", {
      headers: { "X-Admin-Key": "secret" },
    });
    const response = await handleBackfillDEWS(
      db,
      new URL("https://x/api/backfill-dews"),
      "secret",
      request,
    );

    expect(response.status).toBe(200);
    expect(computeDEWS).toHaveBeenCalledWith(
      expect.objectContaining({
        stablecoinId: "1",
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
