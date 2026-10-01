import type { ExitExecutionCertificate, ExitExecutionModelReview } from "../../types/exit-route";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import { exitExecutionReviewDigest, exitExecutionInputGenerationId } from "../safety-score-v9/exit-execution";
import { domainDigest } from "../safety-score-v9/primitives";

export const executionClockSec = 1_790_849_876;
export const executionReview: ExitExecutionModelReview = {
  modelId: "orderbook", identity: { assetId: "fixture-dollar", deployment: "venue:fixture:USD", endpoint: "kraken:fixtureUSD", outputAssetKeys: ["fiat:USD"], implementationIdentity: "kraken-v1:fixtureUSD" },
  holder: "verified-customer", reviewedAt: "2026-09-30T00:00:00.000Z", expiresAt: "2026-10-10T00:00:00.000Z",
  evidenceIds: ["fixture-reviewed-model"], sourceUrls: ["https://example.com/market"],
  producer: { kind: "kraken", market: "fixtureUSD", base: "fixture", quote: "USD", inputDecimals: 6, outputDecimals: 6, outputDeployment: "fiat:USD:venue-balance", settlementEndpoint: "USD-bank-withdrawal" },
};

export function makeExecutionCertificate(): ExitExecutionCertificate {
  const source = { kind: "venue" as const, timestamp: executionClockSec, sequence: "snapshot-1", complete: true, truncated: false };
  const inputReference = { assetKey: "fixture-dollar", deployment: executionReview.identity.deployment, rawUnits: "0", decimals: 6, unitValueUsd: 1, expectedUnitValueUsd: 1, sourceId: "observed-input-price", sourceGenerationId: "price-1", observedAtSec: executionClockSec };
  return {
    modelId: "orderbook", reviewDigest: exitExecutionReviewDigest(executionReview), identity: executionReview.identity,
    inputGenerationId: exitExecutionInputGenerationId("fixture-dollar", 2_000_000, inputReference), observationGenerationId: domainDigest("safety-score-v10.exit-execution-source.v1", source),
    observedAtSec: executionClockSec, sourceMaxAgeSec: 300, priceMaxAgeSec: 300, source,
    holder: "verified-customer", prerequisites: ["eligible-account", "enabled-withdrawal"],
    gates: V9_CANDIDATE_POLICY_V1.policy.semantic.exit.executionModels.orderbook!.requiredGates.map((gateId) => ({ gateId, verdict: "passed", evidenceId: `observed:${gateId}`, observedAtSec: executionClockSec, reason: null })),
    inputReference, feeReferences: [],
    points: [{ requestedNotionalUsd: 100_000, maxCostBps: 200, requestedRawInput: "100000000000", executedRawInput: "100000000000", executableUsd: 100_000, executionCostBps: 10, allInCostBps: 10,
      fees: [{ kind: "taker", assetKey: "fiat:USD", rawUnits: "100000000" }], outputs: [{ assetKey: "fiat:USD", deployment: "fiat:USD:venue-balance", rawUnits: "99900000000", decimals: 6, unitValueUsd: 1, expectedUnitValueUsd: 1, sourceId: "observed-usd-book", sourceGenerationId: "price-1", observedAtSec: executionClockSec }], certification: "exact-complete", reason: null }],
    capacityBasis: "exhaustive-book-walk", settlement: { endpoint: "USD-bank-withdrawal", maximumCompletionSec: 3600, evidenceId: "withdrawal-sla" }, resourceKeys: ["kraken-account-inventory"], failureDomainKeys: ["venue:kraken"],
  };
}
