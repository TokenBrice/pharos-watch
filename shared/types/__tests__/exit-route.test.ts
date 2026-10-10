import { describe, expect, it } from "vitest";
import { ExitExecutionCertificateSchema, ExitExecutionModelReviewSchema, ExitRouteObservationSchema, ExitRouteOutputSchema } from "../exit-route";
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

describe("exit output quote domains", () => {
  const physical = { kind: "physical-commodity-delivery", assetKeys: ["commodity:xau"], sameNotionalEligible: false };

  it("admits distinct fiat and non-same-notional physical outputs", () => {
    expect(ExitRouteOutputSchema.safeParse(physical).success).toBe(true);
    expect(ExitRouteOutputSchema.safeParse({ kind: "fiat", currency: "USD" }).success).toBe(true);
  });

  it.each(["commodity:xau", "commodity:xag"])("admits canonical physical commodity identity %s", (assetKey) => {
    expect(ExitRouteOutputSchema.safeParse({ ...physical, assetKeys: [assetKey] }).success).toBe(true);
  });

  it.each([
    { sameNotionalEligible: undefined },
    { assetKeys: ["usdc-circle"] },
    { assetKeys: ["commodity:gold"] },
    { assetKeys: ["commodity:silver"] },
    { assetKeys: ["commodity:XAU"] },
    { currency: "USD" },
    { trackedAssetIds: ["usdc-circle"] },
    { basketWeights: [] },
  ])("rejects physical output with incompatible fields %j", (fields) => {
    expect(ExitRouteOutputSchema.safeParse({ ...physical, ...fields }).success).toBe(false);
  });

  it("withholds a physical par valuation without explicit USD evidence", () => {
    const value = { ...observation(), output: physical, executionModelId: undefined, executionCertificate: undefined, scoreEligible: false };
    expect(ExitRouteObservationSchema.safeParse(value).success).toBe(true);
    expect(ExitRouteObservationSchema.safeParse({ ...value, outputUnitValueUsd: 1 }).success).toBe(false);
    expect(ExitRouteObservationSchema.safeParse({
      ...value, outputUnitValueUsd: 2_500, outputUnitValueSourceId: "metal-usd-reference", outputUnitValueObservedAt: executionClockSec,
    }).success).toBe(true);
    expect(ExitRouteOutputSchema.safeParse({ kind: "fiat" }).success).toBe(false);
    expect(ExitRouteOutputSchema.safeParse({ kind: "fiat", currency: "USD", assetKeys: ["commodity:xau"] }).success).toBe(false);
  });
});
