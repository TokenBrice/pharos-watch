import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "../../test-helpers/__shared/auth";
import { handleBackfillDEWS } from "../backfill-dews";
import { BACKTEST_ANCHORS } from "../../lib/backtest-anchors";

stubCryptoForAuth();

const DAY = 86_400;

describe("GET /api/backfill-dews?mode=backtest-metrics", () => {
  it("returns detection rate, lead time percentiles (days), and per-anchor detail", async () => {
    // Seed canned stress_signal_history rows for each anchor. The SQL already
    // pushes `band IN ('ALERT','WARNING','DANGER')` + LIMIT 1 into D1, so the
    // mock supplies the single row the real database would return.
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
          { snapshot_date: usdcAnchor.onsetAt - 3 * DAY, band: "ALERT" },
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
          { snapshot_date: usdtAnchor.onsetAt - 5 * DAY, band: "ALERT" },
        ],
      },
      // Negative controls use different binds but the same statement shape.
      { match: "FROM stress_signal_history", rows: [] },
    ]);

    const request = makeApiRequest("/api/backfill-dews?mode=backtest-metrics", {
      adminKey: "secret",
    });
    const response = await handleBackfillDEWS({ db, url: makeApiUrl(request.url), trustedAdmin: true, request });

    const body = (await readJsonResponse(response, 200)) as {
      detectionRate: number;
      precision: number | null;
      recall: number;
      falsePositiveDays: number;
      falseNegativeIncidents: number;
      leadTimeDaysP50: number | null;
      leadTimeDaysP90: number | null;
      alertChurn: { averageAlertDaysPerAnchor: number; bandTransitions: number };
      cohortMetrics: { byPegType: Record<string, { anchors: number; detected: number; recall: number }> };
      granularity: string;
      dataSource: string;
      perAnchor: Array<{
        stablecoinId: string;
        onsetAt: number;
        detected: boolean;
        leadTimeDays: number | null;
        firstAlertBand: string | null;
        alertDays: number;
        bandTransitions: number;
      }>;
    };

    expect(body.detectionRate).toBeGreaterThanOrEqual(0);
    expect(body.detectionRate).toBeLessThanOrEqual(1);
    expect(body.leadTimeDaysP50).toBeDefined();
    expect(body.leadTimeDaysP90).toBeDefined();
    expect(body.precision).toBe(1);
    expect(body.recall).toBeCloseTo(2 / BACKTEST_ANCHORS.length, 6);
    expect(body.falsePositiveDays).toBe(0);
    expect(body.falseNegativeIncidents).toBe(BACKTEST_ANCHORS.length - 2);
    expect(body.alertChurn.averageAlertDaysPerAnchor).toBeGreaterThan(0);
    expect(body.cohortMetrics.byPegType).toHaveProperty("peggedUSD");
    expect(body.granularity).toBe("daily");
    expect(body.dataSource).toBe("stress_signal_history");
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
