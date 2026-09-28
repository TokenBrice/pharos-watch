import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DepegEventStoredSnapshotSchema } from "@shared/types/market";
import type { DepegEvent } from "@shared/types/market";
import { computePegScore } from "@shared/lib/peg-score";
import { DDR_INELIGIBLE_AUDIT_VERDICTS, PEG_SCORE_EXCLUDED_AUDIT_VERDICTS } from "@shared/types/depeg-audit";
import { isDdrIneligibleAuditVerdict, isPegScoreExcludedAuditVerdict } from "@shared/lib/depeg-audit";
import { auditVerdictNotInSql } from "../depeg-audit";
import { rowToDepegEvent, type DepegRow } from "../depeg-helpers";
import { sealPredictionFixture, withSqliteD1 } from "./depeg-resolver-ddrv2-store.test-support";

const cases = [
  [null, true, true],
  ["confirmed", true, true],
  ["repaired", true, true],
  ["false_positive", false, false],
  ["disputed", false, false],
  ["no_data", true, false],
  ["future_unknown", false, false],
] as const;

const archiveEvent = {
  id: 1, slug: "lusd", stablecoinId: "lusd-liquity", symbol: "LUSD", pegType: "peggedUSD",
  direction: "below", peakDeviationBps: -300, startedAt: 100000, endedAt: null,
  startPrice: 0.97, peakPrice: 0.97, recoveryPrice: null, pegReference: 1, source: "live",
};

describe("audit verdict eligibility", () => {
  it.each(cases)("keeps TS, SQL and archive policy distinct for %s", (verdict, pegEligible, ddrEligible) => {
    expect(!isPegScoreExcludedAuditVerdict(verdict)).toBe(pegEligible);
    // Deliberately bypass the typed boundary to exercise unknown archived runtime input.
    const score = computePegScore([{ ...archiveEvent, provenance: { auditVerdict: verdict } } as unknown as DepegEvent], 1, 2_000_000);
    expect(score.scoredEventCount).toBe(pegEligible ? 1 : 0);
    expect(score.activeDepeg).toBe(pegEligible);
    expect(!isDdrIneligibleAuditVerdict(verdict)).toBe(ddrEligible);
    const sqlite = new DatabaseSync(":memory:");
    try {
      for (const [excluded, eligible] of [[PEG_SCORE_EXCLUDED_AUDIT_VERDICTS, pegEligible], [DDR_INELIGIBLE_AUDIT_VERDICTS, ddrEligible]] as const) {
        const fragment = auditVerdictNotInSql("verdict", excluded);
        const row = sqlite.prepare(`SELECT ${fragment.sql} AS eligible FROM (SELECT ? AS verdict)`).get(...fragment.binds, verdict);
        expect(row?.eligible).toBe(eligible ? 1 : 0);
      }
    } finally { sqlite.close(); }
    const archived = DepegEventStoredSnapshotSchema.safeParse([{ ...archiveEvent, provenance: { auditVerdict: verdict } }]);
    expect(archived.success).toBe(verdict !== "future_unknown");
    if (archived.success) expect(archived.data[0].provenance?.auditVerdict).toBe(verdict);
  });

  it.each(["json", "column"] as const)("rejects unknown database %s provenance instead of replacing it with null", (source) => {
    const row: DepegRow = {
      id: 1, stablecoin_id: "lusd-liquity", symbol: "LUSD", peg_type: "peggedUSD",
      direction: "below", peak_deviation_bps: -300, started_at: 100000, ended_at: null,
      start_price: 0.97, peak_price: 0.97, recovery_price: null, peg_reference: 1,
      source: "live", confirmation_sources: null, pending_reason: null,
      ...(source === "json"
        ? { provenance_json: JSON.stringify({ auditVerdict: "future_unknown" }) }
        : { provenance_audit_verdict: "future_unknown" }),
    };
    expect(() => rowToDepegEvent(row)).toThrow();
  });

  it.each(cases)("latest schema guards sealed provenance insert/update for %s", async (verdict, _pegEligible, ddrEligible) => {
    await withSqliteD1(async (db) => {
      await sealPredictionFixture(db);
      const insert = () => db.sqlite.prepare("INSERT INTO depeg_event_provenance (event_id, source_kind, audit_verdict, created_at, updated_at) VALUES (1, 'live', ?, 200000, 200000)").run(verdict);
      if (ddrEligible) {
        insert();
        expect(db.sqlite.prepare("SELECT audit_verdict FROM depeg_event_provenance WHERE event_id = 1").get()?.audit_verdict).toBe(verdict);
      } else {
        expect(insert).toThrow();
        db.sqlite.exec("INSERT INTO depeg_event_provenance (event_id, source_kind, audit_verdict, created_at, updated_at) VALUES (1, 'live', NULL, 200000, 200000)");
      }
      const update = () => db.sqlite.prepare("UPDATE depeg_event_provenance SET audit_verdict = ? WHERE event_id = 1").run(verdict);
      if (ddrEligible) {
        update();
        expect(db.sqlite.prepare("SELECT audit_verdict FROM depeg_event_provenance WHERE event_id = 1").get()?.audit_verdict).toBe(verdict);
      } else {
        expect(update).toThrow();
        expect(db.sqlite.prepare("SELECT audit_verdict FROM depeg_event_provenance WHERE event_id = 1").get()?.audit_verdict).toBeNull();
      }
    });
  });
});
