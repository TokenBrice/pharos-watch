import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "../../test-helpers/__shared/auth";
import { handleBackfillDEWS } from "../backfill-dews";
import { BACKTEST_ANCHORS } from "../../lib/backtest-anchors";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import type { BacktestNegativeControl } from "../../lib/backtest-anchors";
import type * as BacktestAnchors from "../../lib/backtest-anchors";
import type { DatabaseSync } from "node:sqlite";
import type { D1Database } from "@shared/types/cloudflare-runtime";

const { controls } = vi.hoisted(() => ({ controls: [] as BacktestNegativeControl[] }));
vi.mock("../../lib/backtest-anchors", async (importOriginal) => ({
  ...(await importOriginal<typeof BacktestAnchors>()),
  BACKTEST_NEGATIVE_CONTROLS: controls,
}));

stubCryptoForAuth();

const DAY = 86_400;

type Metrics = {
  detectionRate: number | null;
  recall: number | null;
  precision: number | null;
  precisionUnavailableReason: string | null;
  falsePositiveDays: number | null;
  falseNegativeIncidents: number;
  evaluableAnchors: number;
  excludedAnchors: number;
  partialAnchors: number;
  leadTimeDaysP50: number | null;
  leadTimeDaysP90: number | null;
  granularity: string;
  dataSource: string;
  alertChurn: { averageAlertDaysPerAnchor: number | null; bandTransitions: number | null };
  cohortMetrics: {
    byPegType: Record<string, { anchors: number; evaluableAnchors: number; detected: number; recall: number | null }>;
    negativeControlCount: number;
    evaluableNegativeControlCount: number;
    observedNegativeControlDays: number;
  };
  perAnchor: Array<{
    stablecoinId: string;
    onsetAt: number;
    detected: boolean | null;
    leadTimeDays: number | null;
    firstAlertBand: string | null;
    alertDays: number;
    bandTransitions: number;
    evaluation: { availability: string; reasons: string[]; observedDays: number; expectedDays: number };
  }>;
  negativeControls: Array<{ falsePositiveDays: number | null; evaluation: Metrics["perAnchor"][number]["evaluation"] }>;
};

function seedWindow(sqlite: DatabaseSync, stablecoinId: string, start: number, end: number, alertDay?: number) {
  const insert = sqlite.prepare("INSERT INTO stress_signal_history (stablecoin_id, snapshot_date, score, band, signals_json) VALUES (?, ?, ?, ?, '{}')");
  for (let day = Math.ceil(start / DAY) * DAY; day <= end; day += DAY) {
    insert.run(stablecoinId, day, day === alertDay ? 67 : 0, day === alertDay ? "WARNING" : "CALM");
  }
}

async function readMetrics(db: D1Database) {
  const request = makeApiRequest("/api/backfill-dews?mode=backtest-metrics", { adminKey: "secret" });
  return readJsonResponse<Metrics>(await handleBackfillDEWS({ db, url: makeApiUrl(request.url), trustedAdmin: true, request }), 200);
}

afterEach(() => { controls.length = 0; });

describe("GET /api/backfill-dews?mode=backtest-metrics", () => {
  it("keeps retained calibration scores immutable across the TVL-basis release", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const anchor = BACKTEST_ANCHORS[0];
    const snapshotDate = Math.floor(anchor.onsetAt / DAY) * DAY - 3 * DAY;
    try {
      seedWindow(sqlite, anchor.stablecoinId, anchor.onsetAt - 14 * DAY, anchor.onsetAt, snapshotDate);
      const before = sqlite.prepare("SELECT * FROM stress_signal_history").all();
      const body = await readMetrics(db);
      expect(body.perAnchor.find((row) => row.onsetAt === anchor.onsetAt)).toMatchObject({
        detected: true, leadTimeDays: (anchor.onsetAt - snapshotDate) / DAY,
      });
      expect(sqlite.prepare("SELECT * FROM stress_signal_history").all()).toEqual(before);
    } finally {
      sqlite.close();
    }
  });
  it("scores complete observed windows, excludes absent anchors, and does not fabricate no-control precision", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const [first, second] = BACKTEST_ANCHORS;
    const firstAlertDay = Math.floor(first.onsetAt / DAY) * DAY - 3 * DAY;
    const secondAlertDay = Math.floor(second.onsetAt / DAY) * DAY - 5 * DAY;
    try {
      seedWindow(sqlite, first.stablecoinId, first.onsetAt - 14 * DAY, first.onsetAt, firstAlertDay);
      seedWindow(sqlite, second.stablecoinId, second.onsetAt - 14 * DAY, second.onsetAt, secondAlertDay);
      const body = await readMetrics(db);
      expect(body).toMatchObject({
        detectionRate: 1, recall: 1, evaluableAnchors: 2, excludedAnchors: BACKTEST_ANCHORS.length - 2,
        falseNegativeIncidents: 0, precision: null, falsePositiveDays: null,
        precisionUnavailableReason: "no-observed-negative-control-exposure",
        granularity: "daily", dataSource: "stress_signal_history",
      });
      const leadTimes = [(first.onsetAt - firstAlertDay) / DAY, (second.onsetAt - secondAlertDay) / DAY];
      expect(body.leadTimeDaysP50).toBe(leadTimes[0]);
      expect(body.leadTimeDaysP90).toBe(leadTimes[1]);
      expect(body.alertChurn).toEqual({ averageAlertDaysPerAnchor: 1, bandTransitions: 0 });
      expect(body.cohortMetrics.byPegType.peggedUSD).toMatchObject({ evaluableAnchors: 2, detected: 2, recall: 1 });
      expect(body.perAnchor[0]).toMatchObject({
        detected: true, leadTimeDays: leadTimes[0], firstAlertBand: "WARNING",
        evaluation: { availability: "available", observedDays: 14, expectedDays: 14, reasons: [] },
      });
      expect(body.perAnchor).toHaveLength(BACKTEST_ANCHORS.length);
    } finally { sqlite.close(); }
  });

  it("leaves empty history unavailable rather than counting missing anchors as false negatives", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const body = await readMetrics(db);
      expect(body).toMatchObject({
        detectionRate: null, recall: null, evaluableAnchors: 0, excludedAnchors: BACKTEST_ANCHORS.length,
        falseNegativeIncidents: 0, precision: null, falsePositiveDays: null,
        leadTimeDaysP50: null, leadTimeDaysP90: null,
        alertChurn: { averageAlertDaysPerAnchor: null, bandTransitions: null },
      });
      for (const row of body.perAnchor) {
        expect(row).toMatchObject({
          detected: null, leadTimeDays: null,
          evaluation: { availability: "unavailable", observedDays: 0, reasons: ["history-unavailable"] },
        });
      }
      expect(body.cohortMetrics.byPegType.peggedUSD.recall).toBeNull();
    } finally { sqlite.close(); }
  });

  it.each(["CALM", "ALERT"])("keeps a partial %s window unevaluable even when an alert was observed", async (band) => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const anchor = BACKTEST_ANCHORS[0];
    try {
      const day = Math.floor(anchor.onsetAt / DAY) * DAY;
      sqlite.prepare("INSERT INTO stress_signal_history (stablecoin_id, snapshot_date, score, band, signals_json) VALUES (?, ?, 40, ?, '{}')")
        .run(anchor.stablecoinId, day, band);
      const body = await readMetrics(db);
      expect(body).toMatchObject({ recall: null, evaluableAnchors: 0, partialAnchors: 1, falseNegativeIncidents: 0 });
      expect(body.perAnchor[0]).toMatchObject({
        detected: null, leadTimeDays: null, alertDays: band === "ALERT" ? 1 : 0,
        evaluation: { availability: "partial", observedDays: 1, expectedDays: 14, reasons: ["incomplete-daily-history"] },
      });
    } finally { sqlite.close(); }
  });

  it("counts a fully observed calm window as a real false negative and rejects malformed observations", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const anchor = BACKTEST_ANCHORS[0];
    try {
      seedWindow(sqlite, anchor.stablecoinId, anchor.onsetAt - 14 * DAY, anchor.onsetAt);
      expect(await readMetrics(db)).toMatchObject({
        detectionRate: 0, recall: 0, evaluableAnchors: 1, falseNegativeIncidents: 1,
        alertChurn: { averageAlertDaysPerAnchor: 0, bandTransitions: 0 },
      });
      const day = Math.floor(anchor.onsetAt / DAY) * DAY;
      sqlite.prepare("UPDATE stress_signal_history SET band = 'unknown' WHERE stablecoin_id = ? AND snapshot_date = ?").run(anchor.stablecoinId, day);
      const body = await readMetrics(db);
      expect(body.perAnchor[0]).toMatchObject({ detected: null, evaluation: { availability: "partial", observedDays: 13 } });
      expect(body.falseNegativeIncidents).toBe(0);
    } finally { sqlite.close(); }
  });

  it("requires full control exposure, preserves observed zero, and counts observed false-positive days", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const anchor = BACKTEST_ANCHORS[0];
    const start = Math.floor(anchor.onsetAt / DAY) * DAY + 30 * DAY;
    // Synthetic controls exercise coverage semantics only; the production registry remains empty.
    controls.push({ stablecoinId: anchor.stablecoinId, windowStart: start, windowEnd: start + 2 * DAY,
      description: "Test-only control", verificationNote: "Synthetic fixture", sourceUrls: [] });
    try {
      seedWindow(sqlite, anchor.stablecoinId, anchor.onsetAt - 14 * DAY, anchor.onsetAt, start - 31 * DAY);
      for (const observed of [0, 1, 3]) {
        if (observed === 1) seedWindow(sqlite, anchor.stablecoinId, start, start);
        if (observed === 3) seedWindow(sqlite, anchor.stablecoinId, start + DAY, start + 2 * DAY);
        const body = await readMetrics(db);
        expect(body.falsePositiveDays).toBe(observed === 3 ? 0 : null);
        expect(body.precision).toBe(observed === 3 ? 1 : null);
        expect(body.negativeControls[0]).toMatchObject({
          falsePositiveDays: observed === 3 ? 0 : null,
          evaluation: { observedDays: observed, expectedDays: 3 },
        });
        expect(body.cohortMetrics.observedNegativeControlDays).toBe(observed === 3 ? 3 : 0);
        if (observed === 1) {
          sqlite.prepare("UPDATE stress_signal_history SET band = 'ALERT', score = 40 WHERE snapshot_date = ?").run(start);
          expect(await readMetrics(db)).toMatchObject({ falsePositiveDays: null, precision: null });
          sqlite.prepare("UPDATE stress_signal_history SET band = 'CALM', score = 0 WHERE snapshot_date = ?").run(start);
        }
      }
      sqlite.prepare("UPDATE stress_signal_history SET band = 'ALERT', score = 40 WHERE snapshot_date = ?").run(start + DAY);
      const body = await readMetrics(db);
      expect(body).toMatchObject({ falsePositiveDays: 1, precision: 0.5, precisionUnavailableReason: null });
      expect(body.cohortMetrics.evaluableNegativeControlCount).toBe(1);
      sqlite.prepare("UPDATE stress_signal_history SET band = 'CALM', score = 0").run();
      expect(await readMetrics(db)).toMatchObject({
        falsePositiveDays: 0, precision: null, precisionUnavailableReason: "no-positive-outcomes",
        falseNegativeIncidents: 1,
      });
    } finally { sqlite.close(); }
  });
});
