import { describe, expect, it } from "vitest";
import { ExitExecutionCertificateSchema, ExitExecutionModelReviewSchema, ExitRouteObservationSchema } from "../exit-route";
import { makeExecutionCertificate, executionClockSec, executionReview } from "../../lib/__tests__/safety-score-v9-exit-execution.test-support";

function observation() {
  const certificate = makeExecutionCertificate();
  return { routeId: "fixture-offramp", routeFamily: "issuer-redemption", scope: { kind: "chain-contract", chain: "ethereum", contractOrPoolId: executionReview.identity.endpoint.split(":")[1], protocol: "securitize-offramp" }, requestedNotionalUsd: 100_000, settlementHorizonSec: 1, maxCostBps: 200, executableUsd: 100_000, completionRatio: 1,
    output: { kind: "tracked-stablecoin", trackedAssetIds: ["fixture-output"], assetKeys: ["fixture-output"] }, evidenceKind: "onchain-contract-state", confidence: "medium", scoreEligible: true, observedAt: executionClockSec, freshnessSeconds: 0, commonModeKeys: ["provider:fixture"], executionModelId: "securitize-offramp", executionCertificate: certificate };
}

describe("execution certificate wire invariants", () => {
  it("rejects the retired Kraken review producer without weakening supported execution reviews", () => {
    expect(ExitExecutionModelReviewSchema.safeParse(executionReview).success).toBe(true);
    expect(ExitExecutionModelReviewSchema.safeParse({
      ...executionReview, producer: { kind: "kraken" },
    }).success).toBe(false);
  });
  it("accepts bound execution but rejects an inflated observation envelope", () => {
    expect(ExitRouteObservationSchema.safeParse(observation()).success).toBe(true);
    expect(ExitRouteObservationSchema.safeParse({ ...observation(), executableUsd: 200_000 }).success).toBe(false);
    expect(ExitRouteObservationSchema.safeParse({ ...observation(), executionCertificate: undefined }).success).toBe(false);
  });
  it("rejects diagnostic or gated capacity advertised as observed execution", () => {
    const value = observation(); value.executionCertificate.points[0]!.certification = "diagnostic";
    value.executionCertificate.points[0]!.reason = "withdrawal-unavailable";
    expect(ExitRouteObservationSchema.safeParse(value).success).toBe(false);
    value.scoreEligible = false;
    expect(ExitRouteObservationSchema.safeParse(value).success).toBe(true);
  });
  it("rejects floating raw units and incomplete sources masquerading as complete", () => {
    const certificate = makeExecutionCertificate(); certificate.points[0]!.executedRawInput = "1.5";
    expect(ExitExecutionCertificateSchema.safeParse(certificate).success).toBe(false);
    const incomplete = makeExecutionCertificate(); incomplete.source.truncated = true; incomplete.points[0]!.certification = "exact-complete";
    expect(ExitExecutionCertificateSchema.safeParse(incomplete).success).toBe(false);
    incomplete.points[0]!.certification = "exact-lower-bound";
    expect(ExitExecutionCertificateSchema.safeParse(incomplete).success).toBe(true);
  });
  it("rejects duplicate request and gate proofs or a substituted output token", () => {
    const duplicate = makeExecutionCertificate(); duplicate.points.push(duplicate.points[0]!);
    expect(ExitExecutionCertificateSchema.safeParse(duplicate).success).toBe(false);
    const wrongOutput = makeExecutionCertificate(); wrongOutput.points[0]!.outputs[0]!.assetKey = "other-token";
    expect(ExitExecutionCertificateSchema.safeParse(wrongOutput).success).toBe(false);
    const missingReason = makeExecutionCertificate(); missingReason.gates[0]!.verdict = "unavailable";
    expect(ExitExecutionCertificateSchema.safeParse(missingReason).success).toBe(false);
  });
});
