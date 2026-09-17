import { describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import type { EvaluatedYieldSource } from "../evaluation";
import { classifyDecisionRetention } from "../publication-decision-persistence";
import { drainDecisionRowsBeforeCutoff } from "../publication";

function decisionSource(
  sourceKey: string,
  anomalies: string[] = [],
): EvaluatedYieldSource {
  return {
    sourceKey,
    confidenceTier: "curated",
    anomalies,
    rejected: false,
  } as EvaluatedYieldSource;
}

describe("yield decision retention parity", () => {
  it("drains classifier-generated audit rows and retains trend and episode rows", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const source = decisionSource("source-a");
      const classifications = [
        classifyDecisionRetention({
          sourceSwitch: false,
          source,
          candidates: [source],
        }),
        classifyDecisionRetention({
          sourceSwitch: true,
          source,
          candidates: [source],
        }),
        classifyDecisionRetention({
          sourceSwitch: false,
          source,
          candidates: [decisionSource("source-a", ["source-stale"])],
        }),
      ];
      expect(classifications.map((row) => row.retentionReason)).toEqual([
        "audit",
        "trend",
        "episode",
      ]);

      const insert = sqlite.prepare(
        `INSERT INTO yield_source_decisions (
           generation_id, stablecoin_id, selected_source_key,
           selected_confidence_tier, selected_data_source, selected_apy_30d,
           selected_reason, source_switch, alternatives_json, created_at,
           retention_reason, trend_fingerprint
         ) VALUES (?, 'coin-a', 'source-a', 'curated', 'test', 4.2,
                   'test', ?, '[]', 100, ?, ?)`,
      );
      for (const [index, classification] of classifications.entries()) {
        insert.run(
          `generation-${index}`,
          classification.retentionReason === "trend" ? 1 : 0,
          classification.retentionReason,
          classification.trendFingerprint,
        );
      }

      expect(await drainDecisionRowsBeforeCutoff({ db, cutoffSec: 200 })).toEqual({
        deleted: 1,
        budgetExhausted: false,
      });
      expect(
        sqlite
          .prepare(
            "SELECT retention_reason FROM yield_source_decisions ORDER BY retention_reason",
          )
          .all(),
      ).toEqual([
        { retention_reason: "episode" },
        { retention_reason: "trend" },
      ]);
    } finally {
      sqlite.close();
    }
  });
});
