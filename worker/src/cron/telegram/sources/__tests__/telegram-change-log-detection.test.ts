import { describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { planDewsAlerts } from "../telegram-alert-changes";
import { diffObservedSafetyGrades, prepareDispatchChangeLogStatements } from "../telegram-change-log-detection";
import type { SafetySnapshot } from "../telegram-alert-snapshots";

const rated = (grade: string | null, extra: Partial<SafetySnapshot[string]> = {}) => ({
  grade, score: grade == null ? null : 70, ratingStatus: "rated", partialEvidence: null, methodologyVersion: "10.26", ...extra,
}) as SafetySnapshot[string];
const symbol = (id: string) => id.toUpperCase();

describe("diffObservedSafetyGrades", () => {
  it("seeds silently, then logs each published move once", () => {
    const seed = diffObservedSafetyGrades(null, { a: rated("B") }, symbol, 100);
    expect(seed.entries).toEqual([]);
    const moved = diffObservedSafetyGrades(seed.next, { a: rated("C") }, symbol, 200);
    expect(moved.entries).toEqual([expect.objectContaining({
      kind: "safety", stablecoinId: "a", observedAt: 200, payload: { symbol: "A", from: "B", to: "C", fromScore: 70, toScore: 70 },
    })]);
    expect(diffObservedSafetyGrades(moved.next, { a: rated("C") }, symbol, 300).entries).toEqual([]);
  });

  it("keeps the last grade through gaps and re-baselines across a methodology change", () => {
    const seed = diffObservedSafetyGrades(null, { a: rated("B") }, symbol, 100).next;
    const gap = diffObservedSafetyGrades(seed, { a: rated(null, { ratingStatus: "pipeline-gap" }) }, symbol, 200);
    expect(gap.entries).toEqual([]);
    expect(gap.next.a?.grade).toBe("B");
    expect(diffObservedSafetyGrades(gap.next, { a: rated("B") }, symbol, 300).entries).toEqual([]);
    expect(diffObservedSafetyGrades(seed, { a: rated("D", { methodologyVersion: "10.27" }) }, symbol, 300).entries).toEqual([]);
  });
});

describe("planDewsAlerts de-escalations", () => {
  it("reports moves down within the alertable range and out of it for the roll-up", () => {
    const rows = [
      { stablecoin_id: "a", score: 45, band: "ALERT", signals_json: null, computed_at: 10 },
      { stablecoin_id: "b", score: 20, band: "WATCH", signals_json: null, computed_at: 10 },
    ];
    const plan = planDewsAlerts(rows, { a: "WARNING", b: "ALERT" }, { a: "WARNING", b: "ALERT" }, {}, symbol, 1_000);
    expect(plan.changes).toEqual([]);
    expect(plan.deescalations.map(({ stablecoinId, oldBand, newBand }) => ({ stablecoinId, oldBand, newBand }))).toEqual([
      { stablecoinId: "a", oldBand: "WARNING", newBand: "ALERT" },
      { stablecoinId: "b", oldBand: "ALERT", newBand: "WATCH" },
    ]);
  });
});

describe("prepareDispatchChangeLogStatements", () => {
  it("prepares idempotent entries plus the observed safety advance without committing them", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const dewsChange = { stablecoinId: "a", symbol: "A", oldBand: "WARNING", newBand: "ALERT", score: 61, topSignals: [] };
      const input = {
        currentSafetySnapshot: { s: rated("B") },
        dewsChanges: [dewsChange],
        dewsRows: [{ stablecoin_id: "a", score: 61, band: "ALERT", signals_json: null, computed_at: 50 }],
        reserveAlerts: [{ stablecoinId: "r", symbol: "R", name: "Reserve coin" }],
        getSymbol: symbol,
        nowSec: 1_000,
      };
      const prepared = await prepareDispatchChangeLogStatements(db, input);
      // Preparation alone writes nothing.
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_change_log").get()).toEqual({ n: 0 });
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM cache").get()).toEqual({ n: 0 });
      await db.batch(prepared);
      // A retried dispatch run re-detects the same DEWS and reserve moves.
      await db.batch(await prepareDispatchChangeLogStatements(db, { ...input, nowSec: 1_300, currentSafetySnapshot: { s: rated("C") } }));
      const rows = sqlite.prepare("SELECT kind, stablecoin_id, observed_at FROM telegram_change_log ORDER BY id").all();
      expect(rows).toEqual([
        { kind: "dews", stablecoin_id: "a", observed_at: 1_000 },
        { kind: "reserve", stablecoin_id: "r", observed_at: 1_000 },
        { kind: "safety", stablecoin_id: "s", observed_at: 1_300 },
      ]);
      const observed = sqlite.prepare("SELECT value FROM cache WHERE key = 'telegram:rollup:safety-observed'").get() as { value: string };
      expect(JSON.parse(observed.value)).toEqual({ s: { grade: "C", score: 70, methodologyVersion: "10.26" } });
    } finally {
      sqlite.close();
    }
  });
});
