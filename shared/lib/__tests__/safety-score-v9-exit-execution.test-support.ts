import type { ExitExecutionCertificate, ExitExecutionModelReview } from "../../types/exit-route";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import { exitExecutionReviewDigest, exitExecutionInputGenerationId } from "../safety-score-v9/exit-execution";
import { domainDigest } from "../safety-score-v9/primitives";

export const executionClockSec = 1_790_849_876;
export const executionReview: ExitExecutionModelReview = {
  modelId: "securitize-offramp", identity: { assetId: "fixture-dollar", deployment: "ethereum:0x0000000000000000000000000000000000000001", endpoint: "ethereum:0x0000000000000000000000000000000000000002", outputAssetKeys: ["fixture-output"], implementationIdentity: `sha256:${"1".repeat(64)}` },
  holder: "whitelisted-primary", reviewedAt: "2026-09-30T00:00:00.000Z", expiresAt: "2026-10-10T00:00:00.000Z",
  evidenceIds: ["fixture-reviewed-model"], sourceUrls: ["https://example.com/market"],
  producer: {
    kind: "securitize-offramp", chain: "ethereum",
    contract: "0x0000000000000000000000000000000000000002",
    implementation: "0x0000000000000000000000000000000000000003",
    provider: "0x0000000000000000000000000000000000000004",
    inputToken: "0x0000000000000000000000000000000000000001",
    outputToken: "0x0000000000000000000000000000000000000005",
    inputDecimals: 6, outputDecimals: 6, codeSha256: "1".repeat(64), implementationCodeSha256: "2".repeat(64),
    dependencyCodeIdentities: [1, 2, 3, 4, 5].map((id) => ({
      address: `0x${id.toString(16).padStart(40, "0")}`, codeSha256: "3".repeat(64),
    })),
  },
};

export function makeExecutionCertificate(): ExitExecutionCertificate {
  const source = { kind: "block" as const, timestamp: executionClockSec, number: 1, hash: `0x${"1".repeat(64)}`, complete: true, truncated: false };
  const inputReference = { assetKey: "fixture-dollar", deployment: executionReview.identity.deployment, rawUnits: "0", decimals: 6, unitValueUsd: 1, expectedUnitValueUsd: 1, sourceId: "observed-input-price", sourceGenerationId: "price-1", observedAtSec: executionClockSec };
  return {
    modelId: "securitize-offramp", reviewDigest: exitExecutionReviewDigest(executionReview), identity: executionReview.identity,
    inputGenerationId: exitExecutionInputGenerationId("fixture-dollar", { requestedNotionalUsd: 100_000, maxCostBps: 200 }, inputReference), observationGenerationId: domainDigest("safety-score-v10.exit-execution-source.v1", source),
    observedAtSec: executionClockSec, sourceMaxAgeSec: 300, priceMaxAgeSec: 300, source,
    holder: "whitelisted-primary", prerequisites: ["eligible-holder", "approved-spender"],
    gates: V9_CANDIDATE_POLICY_V1.policy.semantic.exit.executionModels["securitize-offramp"]!.requiredGates.map((gateId) => ({ gateId, verdict: "passed", evidenceId: `observed:${gateId}`, observedAtSec: executionClockSec, reason: null })),
    inputReference, feeReferences: [],
    points: [{ requestedNotionalUsd: 100_000, maxCostBps: 200, requestedRawInput: "100000000000", executedRawInput: "100000000000", executableUsd: 100_000, executionCostBps: 10, allInCostBps: 10,
      fees: [{ kind: "taker", assetKey: "fixture-output", rawUnits: "100000000" }], outputs: [{ assetKey: "fixture-output", deployment: "ethereum:0x0000000000000000000000000000000000000005", rawUnits: "99900000000", decimals: 6, unitValueUsd: 1, expectedUnitValueUsd: 1, sourceId: "observed-output-price", sourceGenerationId: "price-1", observedAtSec: executionClockSec }], certification: "exact-lower-bound", reason: null }],
    capacityBasis: "transaction-simulation", settlement: { endpoint: "ethereum:0x0000000000000000000000000000000000000005", maximumCompletionSec: 0, evidenceId: "observed-transfer" }, resourceKeys: ["fixture-provider-inventory"], failureDomainKeys: ["provider:fixture"],
  };
}
