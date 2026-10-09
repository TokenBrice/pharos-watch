import { describe, expect, it } from "vitest";
import { EvidenceLossOutcomeSchema } from "@shared/types/evidence-loss";
import { isCarryEligible, summarizeEvidenceLossOutcomes } from "@shared/lib/evidence-loss";
import { classifyRedemptionEntryLosses, classifyRedemptionLossReason, redemptionLossOutcome } from "../redemption-backstop/loss";
import { buildFailedRedemptionBackstopEntry } from "../redemption-backstop/sources";
import { getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import { makeRedemptionWriteRecord } from "./redemption-backstops-store.test-support";
import { RedemptionCapacityRejectionReasonSchema, RedemptionQuarantineReasonSchema } from "@shared/types/redemption";

const RUN = "redemption:attempt";
const NOW = 1_790_000_000;

describe("redemption loss dispositions", () => {
  it.each([...new Set([...RedemptionCapacityRejectionReasonSchema.options, ...RedemptionQuarantineReasonSchema.options])])(
    "classifies the complete producer and capture vocabulary without operational promotion: %s",
    (reason) => {
      const disposition = classifyRedemptionLossReason(reason);
      expect(["unknown", "semantic", "evidential"]).toContain(disposition);
      const loss = redemptionLossOutcome({
        assetId: "usdc-circle", routeKey: "redemption:usdc-circle:offchain-issuer", reason, disposition,
        runId: RUN, observedAtSec: NOW,
      });
      expect(isCarryEligible(loss, NOW)).toBe(false);
    },
  );

  it("materializes generic sync failure as unknown independently of the Safety A-cause", () => {
    const entry = buildFailedRedemptionBackstopEntry("usdc-circle", getRedemptionBackstopConfig("usdc-circle")!, NOW, RUN);
    expect(entry.lossOutcomes?.[0]).toMatchObject({
      disposition: "unknown", reason: "sync-error", attemptId: RUN, runId: RUN,
      observedAtSec: NOW, priorEvidence: null, proof: null, legacy: false,
      scope: { assetId: "usdc-circle", kind: "route", key: "redemption:usdc-circle:offchain-issuer" },
    });
    expect(isCarryEligible(entry.lossOutcomes![0], NOW)).toBe(false);
  });

  it("never infers operational status for legacy failed rows", () => {
    const entry = makeRedemptionWriteRecord({ resolutionState: "failed", score: null, provider: "sync-error" });
    const [loss] = classifyRedemptionEntryLosses(entry, null);
    expect(loss).toMatchObject({ disposition: "unknown", reason: "sync-error", legacy: true, attemptId: null, runId: null });
    expect(isCarryEligible(loss, NOW)).toBe(false);
  });

  it.each([
    ["malformed-telemetry", "semantic"], ["config-mismatch", "semantic"],
    ["stale-source-timestamp", "evidential"], ["missing-source-timestamp", "unknown"],
    ["reserve-semantic-invalidated", "semantic"], ["reserve-evidential-invalidated", "evidential"],
    ["reserve-unknown-invalidated", "unknown"],
  ] as const)("classifies %s as %s without operational promotion", (reason, disposition) => {
    const [loss] = classifyRedemptionEntryLosses(makeRedemptionWriteRecord({ capacityRejectionReason: reason }), RUN);
    expect(loss).toMatchObject({ reason, disposition, priorEvidence: null });
    expect(isCarryEligible(loss, NOW)).toBe(false);
  });

  it.each([
    ["config-mismatch", "semantic"], ["malformed-persisted-row", "semantic"],
    ["stale", "evidential"], ["output-stale", "evidential"],
    ["freshness-unverified", "unknown"], ["sync-error", "unknown"], ["reserve-invalidated", "unknown"],
  ] as const)("uses the same authority for capture rejection %s", (reason, disposition) => {
    expect(classifyRedemptionLossReason(reason)).toBe(disposition);
  });

  it("does not erase or relabel an observed zero as a producer loss", () => {
    const entry = makeRedemptionWriteRecord({ score: 0, immediateCapacityUsd: 0, immediateCapacityRatio: 0 });
    expect(classifyRedemptionEntryLosses(entry, RUN)).toEqual([]);
    expect(entry).toMatchObject({ score: 0, immediateCapacityUsd: 0 });
  });

  it("refuses operational assertions without all required leg proofs", () => {
    const unknown = redemptionLossOutcome({ assetId: "usdc-circle", routeKey: "redemption:usdc-circle:offchain-issuer",
      reason: "sync-error", disposition: "unknown", runId: RUN, observedAtSec: NOW });
    expect(EvidenceLossOutcomeSchema.safeParse({ ...unknown, disposition: "operational", reason: "timeout" }).success).toBe(false);
  });

  it("keeps a complete count when asset diagnostics exceed the sample bound", () => {
    const losses = Array.from({ length: 31 }, (_, index) => redemptionLossOutcome({
      assetId: `asset-${index}`, routeKey: `redemption:asset-${index}:offchain-issuer`, reason: "sync-error",
      disposition: "unknown", runId: RUN, observedAtSec: NOW,
    }));
    expect(summarizeEvidenceLossOutcomes(losses)).toMatchObject({ total: 31, byDisposition: { unknown: 31, operational: 0 }, byReason: [{ reason: "sync-error", count: 31 }] });
  });
});
