import { describe, expect, it } from "vitest";
import { ExitExecutionCertificateSchema, ExitRouteObservationSchema } from "../exit-route";
import { makeExecutionCertificate, executionClockSec } from "../../lib/__tests__/safety-score-v9-exit-execution.test-support";

function observation() {
  const certificate = makeExecutionCertificate();
  return { routeId: "fixture-book", routeFamily: "dex-orderbook", scope: { kind: "venue", venue: "kraken", protocol: "kraken" }, requestedNotionalUsd: 100_000, settlementHorizonSec: 3600, maxCostBps: 200, executableUsd: 100_000, completionRatio: 1,
    output: { kind: "fiat", currency: "USD", assetKeys: ["fiat:USD"] }, evidenceKind: "direct-orderbook-depth", confidence: "medium", scoreEligible: true, observedAt: executionClockSec, freshnessSeconds: 0, commonModeKeys: ["venue:kraken"], executionModelId: "orderbook", executionCertificate: certificate };
}

describe("execution certificate wire invariants", () => {
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
    const incomplete = makeExecutionCertificate(); incomplete.source.truncated = true;
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
