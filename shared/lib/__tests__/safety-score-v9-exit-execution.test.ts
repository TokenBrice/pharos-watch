import { describe, expect, it } from "vitest";
import { admitExitExecutionCertificate, exitExecutionInputGenerationId, projectExitExecutionCertificate, resolveExitExecutionRequestPoint } from "../safety-score-v9/exit-execution";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import { evaluateV9Exit, selectV9ExitStressRequest } from "../safety-score-v9/exit";
import { makeExitRoute } from "./safety-score-v9-exit.test-support";
import { executionClockSec, executionReview, makeExecutionCertificate } from "./safety-score-v9-exit-execution.test-support";
import type { ExitExecutionCertificate } from "../../types/exit-route";

function admission(certificate: ExitExecutionCertificate, clockSec = executionClockSec, circulatingUsd = 2_000_000) {
  const request = selectV9ExitStressRequest(circulatingUsd, V9_CANDIDATE_POLICY_V1)!;
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

  it("admits supply drift within the selected bucket but rejects a changed request even if its point was measured", () => {
    const certificate = makeExecutionCertificate();
    expect(admission(certificate, executionClockSec, 1_900_000)).toMatchObject({ state: "observed" });
    const larger = structuredClone(certificate.points[0]!);
    Object.assign(larger, { requestedNotionalUsd: 1_000_000, requestedRawInput: "1000000000000", executedRawInput: "1000000000000", executableUsd: 1_000_000 });
    larger.outputs[0]!.rawUnits = "999000000000";
    larger.fees[0]!.rawUnits = "1000000000";
    certificate.points.push(larger);
    expect(admission(certificate, executionClockSec, 2_000_001)).toMatchObject({ state: "unavailable", reason: "execution-generation-mismatch" });
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
    expect(admission(makeExecutionCertificate(), executionClockSec + 300, 1_900_000).state).toBe("observed");
    expect(admission(makeExecutionCertificate(), executionClockSec + 301, 1_900_000)).toMatchObject({ state: "unavailable", reason: "execution-source-stale" });
    const certificate = makeExecutionCertificate();
    certificate.gates[0]!.observedAtSec -= 301;
    expect(admission(certificate)).toMatchObject({ state: "unavailable", reason: `execution-gate-stale:${certificate.gates[0]!.gateId}` });
    certificate.gates[0]!.observedAtSec = executionClockSec;
    certificate.points[0]!.outputs[0]!.observedAtSec -= 301;
    expect(admission(certificate)).toMatchObject({ state: "unavailable", reason: "execution-price-stale" });
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
});
