import { describe, expect, it } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "./helpers/auth";
import { handleBackfillDEWS } from "../backfill-dews";
import { BACKTEST_ANCHORS } from "../../lib/backtest-anchors";

stubCryptoForAuth();

const DAY = 86_400;

describe("GET /api/backfill-dews?mode=backtest-metrics", () => {
  it("returns detection rate, lead time percentiles (days), and per-anchor detail", async () => {
    // Seed canned stress_signal_history rows for each anchor. The first anchor
    // (USDC-SVB) gets an ALERT 3 days before onset; the second (USDT) gets an
    // ALERT 5 days before onset. Remaining anchors get no rows (undetected).
    const [usdcAnchor, usdtAnchor] = BACKTEST_ANCHORS;
    const db = mockD1([
      {
        match: "FROM stress_signal_history",
        matchBinds: [
          usdcAnchor.stablecoinId,
          usdcAnchor.onsetAt - 14 * DAY,
          usdcAnchor.onsetAt,
        ],
        rows: [
          { snapshot_date: usdcAnchor.onsetAt - 6 * DAY, band: "WATCH" },
          { snapshot_date: usdcAnchor.onsetAt - 3 * DAY, band: "ALERT" },
          { snapshot_date: usdcAnchor.onsetAt - 1 * DAY, band: "WARNING" },
        ],
      },
      {
        match: "FROM stress_signal_history",
        matchBinds: [
          usdtAnchor.stablecoinId,
          usdtAnchor.onsetAt - 14 * DAY,
          usdtAnchor.onsetAt,
        ],
        rows: [
          { snapshot_date: usdtAnchor.onsetAt - 10 * DAY, band: "CALM" },
          { snapshot_date: usdtAnchor.onsetAt - 5 * DAY, band: "ALERT" },
        ],
      },
    ]);

    const request = makeApiRequest("/api/backfill-dews?mode=backtest-metrics", {
      adminKey: "secret",
    });
    const response = await handleBackfillDEWS(
      db,
      makeApiUrl(request.url),
      true,
      request,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      detectionRate: number;
      leadTimeDaysP50: number | null;
      leadTimeDaysP90: number | null;
      granularity: string;
      perAnchor: Array<{
        stablecoinId: string;
        onsetAt: number;
        detected: boolean;
        leadTimeDays: number | null;
        firstAlertBand: string | null;
      }>;
    };

    expect(body.detectionRate).toBeGreaterThanOrEqual(0);
    expect(body.detectionRate).toBeLessThanOrEqual(1);
    expect(body.leadTimeDaysP50).toBeDefined();
    expect(body.leadTimeDaysP90).toBeDefined();
    expect(body.granularity).toBe("daily");
    expect(Array.isArray(body.perAnchor)).toBe(true);
    expect(body.perAnchor.length).toBe(BACKTEST_ANCHORS.length);
    expect(body.perAnchor[0]).toMatchObject({
      stablecoinId: expect.any(String),
      onsetAt: expect.any(Number),
      detected: expect.any(Boolean),
      leadTimeDays: expect.any(Number),
      firstAlertBand: expect.any(String),
    });

    // Detection math: 2 of N anchors had an ALERT+ row in the 14-day window.
    expect(body.detectionRate).toBeCloseTo(2 / BACKTEST_ANCHORS.length, 6);

    const firstAnchorResult = body.perAnchor.find(
      (entry) => entry.stablecoinId === usdcAnchor.stablecoinId,
    );
    expect(firstAnchorResult).toMatchObject({
      detected: true,
      leadTimeDays: 3,
      firstAlertBand: "ALERT",
    });

    const secondAnchorResult = body.perAnchor.find(
      (entry) => entry.stablecoinId === usdtAnchor.stablecoinId,
    );
    expect(secondAnchorResult).toMatchObject({
      detected: true,
      leadTimeDays: 5,
      firstAlertBand: "ALERT",
    });
  });
});
