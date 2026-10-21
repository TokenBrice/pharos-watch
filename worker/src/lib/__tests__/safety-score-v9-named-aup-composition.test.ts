import { describe, expect, it } from "vitest";
import coin from "@shared/data/stablecoins/coins/zarsc-supercoin.json";
import reserves from "@shared/data/stablecoins/domains/reserves/zarsc-supercoin.json";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { buildSafetyScoreV9ReviewedAuditedFallbackReserveRows, buildSafetyScoreV9ReviewedStaticReserveRows } from "../safety-score-v9/extension-reserves";
import type { V9ExtensionRegistryMeta } from "../safety-score-v9/extension-shared";

const meta = { ...coin, ...reserves } as unknown as V9ExtensionRegistryMeta;
const clock = Date.parse("2026-10-22T00:00:00Z") / 1000;
const reportExpiry = Date.parse("2026-09-30T00:00:00Z") / 1000
  + V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.namedFirmReserveReportMaxAgeSec;

describe("named AUP historical composition, not assurance", () => {
  it("admits the complete named historical cash composition only as static-validated", () => {
    const admission = buildSafetyScoreV9ReviewedAuditedFallbackReserveRows(meta, clock);
    expect(admission?.evidenceClass).toBe("static-validated");
    expect(admission?.rows).toHaveLength(1);
    expect(admission?.rows[0]?.pct).toBe(100);
    expect(meta.reserveReview?.compositionAsOf).toBe("2026-09-30");
    expect(meta.proofOfReserves?.latestReport?.liabilityReconciliation).toBe("partial");
    const supervised = { ...meta, mintAuthority: { ...meta.mintAuthority!, supervision: "prudential" as const } };
    expect(buildSafetyScoreV9ReviewedStaticReserveRows(supervised, clock)?.evidenceClass).toBe("static-validated");
  });
  it("rejects unidentified firms, mismatched methods/periods, incomplete scope and expired reports", () => {
    const unknown = structuredClone(meta);
    unknown.proofOfReserves!.provider = "Unknown provider";
    expect(buildSafetyScoreV9ReviewedAuditedFallbackReserveRows(unknown, clock)).toBeNull();
    const method = structuredClone(meta);
    method.proofOfReserves!.latestReport!.assuranceMethod = "audit";
    expect(buildSafetyScoreV9ReviewedAuditedFallbackReserveRows(method, clock)).toBeNull();
    const period = structuredClone(meta);
    period.reserveReview!.compositionAsOf = "2026-08-31";
    expect(buildSafetyScoreV9ReviewedAuditedFallbackReserveRows(period, clock)).toBeNull();
    const scope = structuredClone(meta);
    scope.reserveReview!.confidence = "unknown";
    expect(buildSafetyScoreV9ReviewedAuditedFallbackReserveRows(scope, clock)).toBeNull();
    const incomplete = structuredClone(meta);
    incomplete.reserves![0]!.pct = 50;
    expect(buildSafetyScoreV9ReviewedAuditedFallbackReserveRows(incomplete, clock)).toBeNull();
    expect(buildSafetyScoreV9ReviewedAuditedFallbackReserveRows(meta, reportExpiry + 1)).toBeNull();
    expect(buildSafetyScoreV9ReviewedAuditedFallbackReserveRows(meta, Date.parse("2026-10-20T00:00:00Z") / 1000)).toBeNull();
  });
});
