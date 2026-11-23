import { describe, expect, it } from "vitest";
import { admitExitExecutionCertificate, exitExecutionInKindReviewDigest, exitExecutionInputGenerationId, exitExecutionReviewDigest, projectExitExecutionCertificate, resolveExitExecutionRequestPoint } from "../safety-score-v9/exit-execution";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import { evaluateV9Exit, selectV9ExitStressRequest } from "../safety-score-v9/exit";
import { makeExitRoute } from "./safety-score-v9-exit.test-support";
import { executionClockSec, executionReview, makeExecutionCertificate } from "./safety-score-v9-exit-execution.test-support";
import { ExitExecutionPublicCertificateSchema, type ExitExecutionCertificate, type ExitExecutionModelReview } from "../../types/exit-route";

function admission(certificate: ExitExecutionCertificate, clockSec = executionClockSec, requestedNotionalUsd = 100_000) {
  const request = { requestedNotionalUsd, maxCostBps: 200 };
  return admitExitExecutionCertificate({ certificate, envelope: V9_CANDIDATE_POLICY_V1, assetId: "fixture-dollar", clockSec,
    inputGenerationId: exitExecutionInputGenerationId("fixture-dollar", request, certificate.inputReference), observationGenerationId: certificate.observationGenerationId,
    request, reviews: [executionReview] });
}

describe("exact-request execution certificate admission", () => {
  it("admits a full executable request and a separately proven partial execution, but not unavailable state", () => {
    expect(admission(makeExecutionCertificate())).toMatchObject({ state: "observed", point: { executableUsd: 100_000 } });
    const partial = makeExecutionCertificate();
    Object.assign(partial.points[0]!, { executedRawInput: "50000000000", executableUsd: 50_000, certification: "exact-lower-bound" });
    partial.points[0]!.outputs[0]!.rawUnits = "49950000000";
    expect(admission(partial)).toMatchObject({ state: "observed", point: { executableUsd: 50_000 } });
    partial.gates[0]!.verdict = "unavailable"; partial.gates[0]!.reason = "account-unavailable";
    expect(admission(partial)).toMatchObject({ state: "unavailable", responsibility: "producer-failed", reason: "account-unavailable" });
  });
  it("does not use canonical-attempt diagnostics to change admission, gates or capacity", () => {
    const certificate = makeExecutionCertificate();
    const baseline = admission(certificate);
    certificate.points[0]!.canonicalAttempt = {
      outcome: "accepted-but-unfunded",
      block: { number: 1, hash: `0x${"1".repeat(64)}`, timestamp: executionClockSec },
      requestedRawInput: "100000000000", shareBalanceBefore: "100000000000", shareBalanceAfter: "0",
      totalSupplyBefore: "200000000000", totalSupplyAfter: "100000000000",
      returnedRawOutput: "0", receivedRawOutput: "0", revertData: null,
      reason: "erc4626-canonical-accepted-but-unfunded",
    };
    for (const outcome of ["completed", "accepted-but-unfunded", "reverted", "inconsistent-receipt"] as const) {
      certificate.points[0]!.canonicalAttempt.outcome = outcome;
      const diagnostic = admission(certificate);
      expect(diagnostic.state).toBe(baseline.state);
      if (diagnostic.state !== "unavailable" && baseline.state !== "unavailable") {
        expect(diagnostic.point.executableUsd).toBe(baseline.point.executableUsd);
        expect(diagnostic.point.executionCostBps).toBe(baseline.point.executionCostBps);
        expect(diagnostic.certificate.gates).toEqual(baseline.certificate.gates);
      }
    }
  });

  it("admits original smaller receipts independently of the stress floor without rewriting their generation", () => {
    const certificate = makeExecutionCertificate();
    const floor = selectV9ExitStressRequest(1_900_000, V9_CANDIDATE_POLICY_V1);
    expect(floor.requestedNotionalUsd).toBe(1_000_000);
    expect(admission(certificate)).toMatchObject({ state: "observed" });
    expect(admission(certificate, executionClockSec, floor.requestedNotionalUsd))
      .toMatchObject({ state: "unavailable", reason: "execution-generation-mismatch" });
    const larger = structuredClone(certificate.points[0]!);
    Object.assign(larger, { requestedNotionalUsd: 1_000_000, requestedRawInput: "1000000000000", executedRawInput: "1000000000000", executableUsd: 1_000_000 });
    larger.outputs[0]!.rawUnits = "999000000000";
    larger.fees[0]!.rawUnits = "1000000000";
    certificate.points.push(larger);
    expect(admission(certificate, executionClockSec, floor.requestedNotionalUsd))
      .toMatchObject({ state: "unavailable", reason: "execution-generation-mismatch" });
  });

  it("retains exact cost-budget and input-valuation binding", () => {
    const certificate = makeExecutionCertificate();
    const request = { requestedNotionalUsd: 100_000, maxCostBps: 199 };
    expect(admitExitExecutionCertificate({
      certificate, envelope: V9_CANDIDATE_POLICY_V1, assetId: "fixture-dollar", clockSec: executionClockSec,
      inputGenerationId: exitExecutionInputGenerationId("fixture-dollar", request, certificate.inputReference),
      observationGenerationId: certificate.observationGenerationId, request, reviews: [executionReview],
    })).toMatchObject({ state: "unavailable", reason: "execution-generation-mismatch" });
    certificate.inputReference.unitValueUsd = 0.99;
    expect(admission(certificate)).toMatchObject({ state: "unavailable", reason: "execution-generation-mismatch" });
  });

  it("preserves observed zero but refuses missing or smaller defining requests", () => {
    const zero = makeExecutionCertificate();
    Object.assign(zero.points[0]!, { executedRawInput: "0", executableUsd: 0, certification: "exact-lower-bound", executionCostBps: 0, allInCostBps: 0, fees: [], reason: "observed-no-execution" });
    zero.points[0]!.outputs[0]!.rawUnits = "0";
    expect(admission(zero)).toMatchObject({ state: "observed", point: { executableUsd: 0 } });
    expect(resolveExitExecutionRequestPoint(zero, { requestedNotionalUsd: 1_000_000, maxCostBps: 200 })).toBeNull();
    zero.points[0]!.requestedNotionalUsd = 10_000;
    zero.points[0]!.requestedRawInput = "10000000000";
    expect(admission(zero)).toMatchObject({ state: "unavailable", reason: "execution-exact-request-missing" });
  });

  it("rejects output depegs and understated costs instead of assuming par", () => {
    const certificate = makeExecutionCertificate();
    certificate.points[0]!.outputs[0]!.unitValueUsd = 0.9;
    expect(admission(certificate)).toMatchObject({ state: "unavailable", reason: "execution-cost-understated" });
    certificate.points[0]!.allInCostBps = 1009;
    expect(admission(certificate)).toMatchObject({ state: "unavailable", reason: "execution-certificate-invalid" });
  });

  it("admits the exact maximum age and rejects one second past it, including gate and output clocks", () => {
    expect(admission(makeExecutionCertificate(), executionClockSec + 300).state).toBe("observed");
    expect(admission(makeExecutionCertificate(), executionClockSec + 301)).toMatchObject({ state: "unavailable", reason: "execution-source-stale" });
    const certificate = makeExecutionCertificate();
    certificate.gates[0]!.observedAtSec -= 301;
    expect(admission(certificate)).toMatchObject({ state: "unavailable", reason: `execution-gate-stale:${certificate.gates[0]!.gateId}` });
    certificate.gates[0]!.observedAtSec = executionClockSec;
    certificate.points[0]!.outputs[0]!.observedAtSec -= 301;
    expect(admission(certificate)).toMatchObject({ state: "unavailable", reason: "execution-price-stale" });
  });

  it.each([
    { offset: -1, admitted: true },
    { offset: 0, admitted: true },
    { offset: 1, admitted: false },
  ])("uses an inclusive execution-review expiry (offset $offset)", ({ offset, admitted }) => {
    const expiresAtSec = executionClockSec + 1;
    const review = { ...executionReview, expiresAt: new Date(expiresAtSec * 1000).toISOString() };
    const certificate = makeExecutionCertificate();
    certificate.reviewDigest = exitExecutionReviewDigest(review);
    const result = admitExitExecutionCertificate({
      certificate, envelope: V9_CANDIDATE_POLICY_V1, assetId: "fixture-dollar",
      clockSec: expiresAtSec + offset, inputGenerationId: certificate.inputGenerationId,
      observationGenerationId: certificate.observationGenerationId,
      request: { requestedNotionalUsd: 100_000, maxCostBps: 200 }, reviews: [review],
    });
    expect(result).toMatchObject(admitted
      ? { state: "observed", point: { executableUsd: 100_000 } }
      : { state: "unavailable", reason: "execution-review-expired", responsibility: "method-unsupported" });
  });

  it("rejects mismatched input units, deployment, implementation and generation", () => {
    const certificate = makeExecutionCertificate();
    certificate.points[0]!.requestedRawInput = "100000000001";
    certificate.points[0]!.certification = "exact-lower-bound";
    expect(admission(certificate)).toMatchObject({ state: "unavailable", reason: "execution-input-units-mismatch" });
    const wrongOutput = makeExecutionCertificate(); wrongOutput.points[0]!.outputs[0]!.deployment = "wrong-chain:USD";
    expect(admission(wrongOutput)).toMatchObject({ state: "unavailable", responsibility: "method-unsupported" });
    const wrongImplementation = makeExecutionCertificate(); wrongImplementation.identity = { ...wrongImplementation.identity, implementationIdentity: "changed" };
    expect(admission(wrongImplementation)).toMatchObject({ state: "unavailable", reason: "execution-identity-unreviewed" });
    expect(admitExitExecutionCertificate({ certificate: makeExecutionCertificate(), envelope: V9_CANDIDATE_POLICY_V1, assetId: "fixture-dollar", clockSec: executionClockSec, inputGenerationId: "other", observationGenerationId: "other", request: { requestedNotionalUsd: 100_000, maxCostBps: 200 }, reviews: [executionReview] })).toMatchObject({ state: "unavailable", reason: "execution-generation-mismatch" });
  });

  it("admits a below-request lower bound but keeps exact-complete at the exact units", () => {
    const certificate = makeExecutionCertificate();
    Object.assign(certificate.points[0]!, { requestedRawInput: "99999999999", executedRawInput: "99999999999" });
    expect(admission(certificate)).toMatchObject({ state: "observed", point: { requestedRawInput: "99999999999", certification: "exact-lower-bound" } });
    certificate.points[0]!.certification = "exact-complete";
    expect(admission(certificate)).toMatchObject({ state: "unavailable", reason: "execution-input-units-mismatch" });
    const zero = makeExecutionCertificate();
    Object.assign(zero.points[0]!, { requestedRawInput: "0", executedRawInput: "0", executableUsd: 0, fees: [], reason: "observed-no-execution" });
    zero.points[0]!.outputs[0]!.rawUnits = "0";
    expect(admission(zero)).toMatchObject({ state: "unavailable", reason: "execution-certificate-invalid" });
  });

  it("refuses unproven settlement, future reviews and issuer non-disclosure", () => {
    const certificate = makeExecutionCertificate(); certificate.settlement.maximumCompletionSec = null;
    expect(admission(certificate)).toMatchObject({ state: "unavailable", reason: "execution-settlement-unproven" });
    const undisclosed = makeExecutionCertificate(); const fee = undisclosed.gates.find((gate) => gate.gateId === "fees")!;
    fee.verdict = "unavailable"; fee.reason = "issuer-undisclosed";
    expect(admission(undisclosed)).toMatchObject({ state: "unavailable", responsibility: "issuer-undisclosed" });
    expect(admission(makeExecutionCertificate(), Date.parse(executionReview.reviewedAt) / 1000 - 1)).toMatchObject({ state: "unavailable", reason: "execution-review-expired" });
  });
  it("refuses every missing required gate on an otherwise executable request", () => {
    for (const requiredGate of V9_CANDIDATE_POLICY_V1.policy.semantic.exit.executionModels["securitize-offramp"]!.requiredGates) {
      const certificate = makeExecutionCertificate();
      certificate.gates = certificate.gates.filter((gate) => gate.gateId !== requiredGate);
      expect(admission(certificate)).toMatchObject({
        state: "unavailable", reason: `execution-gate-missing:${requiredGate}`,
      });
    }
  });


  it("keeps old scoring available while withholding a new uncertified model even with a favorable producer flag", () => {
    const legacy = makeExitRoute();
    const score = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [legacy] }, V9_CANDIDATE_POLICY_V1);
    const uncertified = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [{ ...legacy, executionModelId: "securitize-offramp" }] }, V9_CANDIDATE_POLICY_V1);
    expect(score.routes[0]!.included).toBe(true);
    expect(uncertified.routes[0]).toMatchObject({ included: false, exclusionReason: "unsupported-same-notional-route" });
    expect(uncertified.score).toBeLessThan(score.score!);
  });

  it("publishes proof amounts and gate decisions without private holder prerequisites or evidence identifiers", () => {
    const certificate = makeExecutionCertificate(); certificate.prerequisites.push("private-customer-id");
    certificate.gates[0]!.evidenceId = "private-account-record";
    const projected = projectExitExecutionCertificate(certificate);
    expect(projected.points[0]).toMatchObject({ requestedRawInput: "100000000000", executableUsd: 100_000 });
    expect(projected.gates[0]).toMatchObject({ verdict: "passed" });
    expect(projected).not.toHaveProperty("prerequisites");
    expect(projected.gates[0]).not.toHaveProperty("evidenceId");
  });
  it("projects optional canonical receipt diagnostics and fraction-scoped settlement without private data", () => {
    const certificate = makeExecutionCertificate();
    certificate.points[0]!.canonicalAttempt = {
      outcome: "accepted-but-unfunded",
      block: { number: 1, hash: `0x${"1".repeat(64)}`, timestamp: executionClockSec },
      requestedRawInput: "100000000000", shareBalanceBefore: "100000000000", shareBalanceAfter: "0",
      totalSupplyBefore: "200000000000", totalSupplyAfter: "100000000000",
      returnedRawOutput: "0", receivedRawOutput: "0", revertData: null,
      reason: "erc4626-canonical-accepted-but-unfunded",
    };
    certificate.settlement.scope = "executed-input-only";
    const projected = projectExitExecutionCertificate(certificate);
    expect(ExitExecutionPublicCertificateSchema.parse(projected)).toEqual(projected);
    expect(projected.points[0]!.canonicalAttempt).toMatchObject({ outcome: "accepted-but-unfunded",
      requestedRawInput: "100000000000", returnedRawOutput: "0", receivedRawOutput: "0" });
    expect(projected.points[0]!.canonicalAttempt).not.toHaveProperty("revertData");
    expect(projected.settlement.scope).toBe("executed-input-only");
    const legacy = projectExitExecutionCertificate(makeExecutionCertificate());
    expect(legacy.points[0]).not.toHaveProperty("canonicalAttempt");
    expect(legacy.settlement).not.toHaveProperty("scope");
  });

  it.each([
    { label: "weekday no-op", clock: "2026-11-24T12:16:00Z", capture: "2026-11-24T08:14:00Z", leg: "2026-11-24T07:04:00Z", sourceId: "coingecko+fx-rates:peggedEUR", state: "unavailable", reason: "execution-price-stale", budgetSec: 18_000, budgetBasis: "policy-price-max-age" },
    { label: "weekend production 08:14/07:04 at 12:16", clock: "2026-11-21T12:16:00Z", capture: "2026-11-21T08:14:00Z", leg: "2026-11-21T07:04:00Z", sourceId: "coingecko+fx-rates:peggedEUR", state: "observed", reason: null, budgetSec: 21_600, budgetBasis: "fx-closure-intraday" },
    { label: "in-closure print at exact closure start (21,600s)", clock: "2026-11-21T04:00:00Z", capture: "2026-11-21T00:00:00Z", leg: "2026-11-20T22:00:00Z", sourceId: "coingecko+fx-rates:peggedEUR", state: "observed", reason: null, budgetSec: 21_600, budgetBasis: "fx-closure-intraday" },
    { label: "in-closure print 1s past 6h FX budget", clock: "2026-11-21T04:00:01Z", capture: "2026-11-21T00:00:00Z", leg: "2026-11-20T22:00:00Z", sourceId: "coingecko+fx-rates:peggedEUR", state: "unavailable", reason: "execution-price-stale", budgetSec: 21_600, budgetBasis: "fx-closure-intraday" },
    { label: "in-closure print predating closure start", clock: "2026-11-21T03:00:00Z", capture: "2026-11-20T23:00:00Z", leg: "2026-11-20T21:59:59Z", sourceId: "coingecko+fx-rates:peggedEUR", state: "unavailable", reason: "execution-price-stale", budgetSec: 18_000, budgetBasis: "policy-price-max-age" },
    { label: "1s before Sunday FX reopen", clock: "2026-11-22T21:59:59Z", capture: "2026-11-22T18:00:00Z", leg: "2026-11-22T16:47:59Z", sourceId: "coingecko+fx-rates:peggedEUR", state: "observed", reason: null, budgetSec: 21_600, budgetBasis: "fx-closure-intraday" },
    { label: "post-reopen production 20:18:54/19:05:27 at 00:17:44", clock: "2026-11-23T00:17:44Z", capture: "2026-11-22T20:18:54Z", leg: "2026-11-22T19:05:27Z", sourceId: "coingecko+fx-rates:peggedEUR", state: "observed", reason: null, budgetSec: 21_600, budgetBasis: "fx-closure-intraday" },
    { label: "closure cert at nextOpen + cadence + 1s", clock: "2026-11-23T02:00:01Z", capture: "2026-11-22T21:59:59Z", leg: "2026-11-22T21:00:00Z", sourceId: "coingecko+fx-rates:peggedEUR", state: "unavailable", reason: "execution-price-stale", budgetSec: 18_000, budgetBasis: "policy-price-max-age" },
    { label: "post-reopen cert with post-reopen print", clock: "2026-11-23T03:05:01Z", capture: "2026-11-22T22:15:00Z", leg: "2026-11-22T22:05:00Z", sourceId: "coingecko+fx-rates:peggedEUR", state: "unavailable", reason: "execution-price-stale", budgetSec: 18_000, budgetBasis: "policy-price-max-age" },
    { label: "post-reopen cert inside grace with closure print", clock: "2026-11-23T01:00:00Z", capture: "2026-11-22T22:00:00Z", leg: "2026-11-22T19:59:59Z", sourceId: "coingecko+fx-rates:peggedEUR", state: "unavailable", reason: "execution-price-stale", budgetSec: 18_000, budgetBasis: "policy-price-max-age" },
    { label: "non-FX leg during FX closure", clock: "2026-11-21T12:16:00Z", capture: "2026-11-21T08:14:00Z", leg: "2026-11-21T07:04:00Z", sourceId: "coingecko", state: "unavailable", reason: "execution-price-stale", budgetSec: 18_000, budgetBasis: "policy-price-max-age" },
    { label: "future FX leg during FX closure", clock: "2026-11-21T12:16:00Z", capture: "2026-11-21T08:14:00Z", leg: "2026-11-21T12:17:01Z", sourceId: "coingecko+fx-rates:peggedEUR", state: "unavailable", reason: "execution-price-future", budgetSec: 21_600, budgetBasis: "fx-closure-intraday" },
  ])("applies FX-closure freshness to FX-valued certificate legs: $label", ({ clock, capture, leg, sourceId, state, reason, budgetSec, budgetBasis }) => {
    const clockSec = Date.parse(clock) / 1000;
    const captureSec = Date.parse(capture) / 1000;
    const legSec = Date.parse(leg) / 1000;
    const fxReview: ExitExecutionModelReview = {
      modelId: "erc4626-instant",
      identity: { assetId: "fixture-eur-vault", deployment: "ethereum:0x0000000000000000000000000000000000000011", endpoint: "ethereum:0x0000000000000000000000000000000000000011", outputAssetKeys: ["fixture-eur"], implementationIdentity: `sha256:${"1".repeat(64)}` },
      holder: "any-holder", reviewedAt: "2026-11-01T00:00:00.000Z", expiresAt: "2027-11-01T00:00:00.000Z",
      evidenceIds: ["fixture-eur-review"], sourceUrls: ["https://example.com/vault"],
      producer: {
        kind: "erc4626-instant", chain: "ethereum", chainId: 1, contract: "0x0000000000000000000000000000000000000011",
        outputToken: "0x0000000000000000000000000000000000000012", inputDecimals: 6, outputDecimals: 6, codeSha256: "1".repeat(64),
        balanceStorage: { slot: `0x${"0".repeat(64)}`, keyOrder: "account-slot" }, maxFunctions: "binding",
        unrestrictedGateSelectors: [], multicallCodeSha256: "2".repeat(64),
      },
    };
    const model = V9_CANDIDATE_POLICY_V1.policy.semantic.exit.executionModels["erc4626-instant"]!;
    const request = { requestedNotionalUsd: 1_000_000, maxCostBps: 200 };
    const source = { kind: "block" as const, timestamp: captureSec, number: 1, hash: `0x${"1".repeat(64)}`, complete: true, truncated: false };
    const inputReference = { assetKey: "fixture-eur-vault", deployment: fxReview.identity.deployment, rawUnits: "0", decimals: 6, unitValueUsd: 1.15, expectedUnitValueUsd: 1.15, sourceId: `erc4626-nav:${sourceId}`, sourceGenerationId: "fx-gen-1", observedAtSec: legSec };
    const certificate: ExitExecutionCertificate = {
      modelId: "erc4626-instant", reviewDigest: exitExecutionInKindReviewDigest(fxReview), identity: fxReview.identity,
      inputGenerationId: exitExecutionInputGenerationId("fixture-eur-vault", request, inputReference),
      observationGenerationId: "obs-gen-1", observedAtSec: captureSec, sourceMaxAgeSec: model.sourceMaxAgeSec, priceMaxAgeSec: model.priceMaxAgeSec,
      source, holder: "any-holder", prerequisites: ["counterfactual-share-balance-only", "ordinary-synchronous-redeem", "network-gas-excluded-as-dex"],
      gates: model.requiredGates.map((gateId) => ({ gateId, verdict: "passed", evidenceId: `observed:${gateId}`, observedAtSec: captureSec, reason: null })),
      inputReference, feeReferences: [],
      points: [{ requestedNotionalUsd: 1_000_000, maxCostBps: 200, requestedRawInput: "869565217392", executedRawInput: "869565217392", executableUsd: 1_000_000, executionCostBps: 0, allInCostBps: 0, fees: [], outputs: [{ assetKey: "fixture-eur", deployment: "ethereum:0x0000000000000000000000000000000000000012", rawUnits: "869565217392", decimals: 6, unitValueUsd: 1.15, expectedUnitValueUsd: 1.15, sourceId, sourceGenerationId: "fx-gen-1", observedAtSec: legSec }], certification: "exact-complete", reason: null }],
      capacityBasis: "transaction-simulation", settlement: { endpoint: "ethereum:0x0000000000000000000000000000000000000012", maximumCompletionSec: 0, evidenceId: "observed-transfer", scope: "executed-input-only" },
      resourceKeys: ["exit-resource:fixture-eur-vault"], failureDomainKeys: ["provider:fixture-eur-vault"],
    };
    const verdict = admitExitExecutionCertificate({
      certificate, envelope: V9_CANDIDATE_POLICY_V1, assetId: "fixture-eur-vault", clockSec,
      inputGenerationId: certificate.inputGenerationId, observationGenerationId: certificate.observationGenerationId,
      request, reviews: [fxReview],
    });
    expect(verdict.state).toBe(state);
    expect(verdict.priceFreshness).toMatchObject({ budgetSec, budgetBasis, generationId: "fx-gen-1", reason });
    if (verdict.state === "unavailable") expect(verdict.reason).toBe(reason);
  });
});
