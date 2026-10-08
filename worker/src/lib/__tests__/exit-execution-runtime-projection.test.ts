import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExitExecutionCertificate, ExitExecutionModelReview, ExitExecutionRequestPoint } from "@shared/types/exit-route";
import { loadV9CandidateMethodologyPolicy } from "@shared/lib/safety-score-v9/policy";
import { resolveV9ExitCapacityAtRequest, selectV9ExitStressRequest } from "@shared/lib/safety-score-v9/exit";
import { admitExitExecutionCertificate, exitExecutionInputGenerationId } from "@shared/lib/safety-score-v9/exit-execution";
import { observeReviewedExitExecutionRoutes } from "../exit-execution/runtime";

const CLOCK = 1_791_184_659;
const VAULT = "0x0000000000000000000000000000000000000001";
const TOKEN = "0x0000000000000000000000000000000000000002";
const state = vi.hoisted(() => ({ canonicalCompletion: 1, diagnostic: false }));
vi.mock("@shared/data/safety-score-v9/exit-execution-model-reviews-v1.json", () => ({
  default: { schemaVersion: 1, get reviews() { return [review]; } },
}));
vi.mock("../exit-execution/erc4626-instant", () => ({
  observeErc4626InstantExit: async (args: {
    requests: readonly { requestedNotionalUsd: number; maxCostBps: number }[];
    outputReference: ExitExecutionCertificate["inputReference"];
  }) => ({
    source: { kind: "block", number: 100, hash: `0x${"1".repeat(64)}`, timestamp: CLOCK, complete: true, truncated: false },
    paused: false,
    points: args.requests.map((request): ExitExecutionRequestPoint => {
      const completion = request.requestedNotionalUsd === 1_000_000 ? state.canonicalCompletion
        : request.requestedNotionalUsd >= 10_000_000 ? 40_000 / request.requestedNotionalUsd : 1;
      const executableUsd = request.requestedNotionalUsd * completion;
      const diagnostic = state.diagnostic && request.requestedNotionalUsd === 1_000_000;
      return {
        ...request, requestedRawInput: String(BigInt(request.requestedNotionalUsd) * 1_000_000n),
        executedRawInput: String(BigInt(executableUsd) * 1_000_000n), executableUsd,
        executionCostBps: 0, allInCostBps: 0, fees: [],
        outputs: executableUsd > 0 ? [{ ...args.outputReference, rawUnits: String(BigInt(executableUsd) * 1_000_000n) }] : [],
        certification: diagnostic ? "diagnostic" : completion === 1 ? "exact-complete" : "exact-lower-bound",
        reason: diagnostic ? "erc4626-redeem-reverted" : completion === 1 ? null : "erc4626-liquidity-limited",
      };
    }),
  }),
}));
const review: ExitExecutionModelReview = {
  modelId: "erc4626-instant", holder: "any-holder", reviewedAt: "2026-10-01T00:00:00.000Z", expiresAt: "2026-11-04T00:00:00.000Z",
  identity: { assetId: "fixture-vault", deployment: `ethereum:${VAULT}`, endpoint: `ethereum:${VAULT}`, outputAssetKeys: ["fixture-underlying"], implementationIdentity: `sha256:${"1".repeat(64)}` },
  evidenceIds: ["fixture-verified-source"], sourceUrls: ["https://example.com/verified-vault"],
  producer: { kind: "erc4626-instant", chain: "ethereum", chainId: 1, contract: VAULT, outputToken: TOKEN, inputDecimals: 6, outputDecimals: 6,
    codeSha256: "1".repeat(64), multicallCodeSha256: "1".repeat(64), balanceStorage: { slot: `0x${"0".repeat(64)}`, keyOrder: "account-slot" },
    maxFunctions: "binding", unrestrictedGateSelectors: [] },
};
const inputReference: ExitExecutionCertificate["inputReference"] = {
  assetKey: "fixture-vault", deployment: review.identity.deployment, rawUnits: "0", decimals: 6,
  unitValueUsd: 1, expectedUnitValueUsd: 1, sourceId: "observed-price", sourceGenerationId: "fixture-price", observedAtSec: CLOCK,
};
const outputReference = { ...inputReference, assetKey: "fixture-underlying", deployment: `ethereum:${TOKEN}` };
const call = { assetId: "fixture-vault", circulatingUsd: 10_000_000, clockSec: CLOCK, reviews: [review], inputReference, outputReference };
beforeEach(() => { state.canonicalCompletion = 1; state.diagnostic = false; vi.useFakeTimers(); vi.setSystemTime(CLOCK * 1000); });
afterEach(() => vi.useRealTimers());

describe("canonical ERC4626 receipt projection", () => {
  it("retains nonmonotonic independent grid receipts without invalidating a successful canonical execution curve", async () => {
    const envelope = loadV9CandidateMethodologyPolicy(CLOCK);
    const request = selectV9ExitStressRequest(call.circulatingUsd, envelope)!;
    expect(request.requestedNotionalUsd).toBe(1_000_000);
    const result = await observeReviewedExitExecutionRoutes({ ...call, envelope });
    expect(result.failures).toEqual([]);
    const observation = result.observations[0]!;
    expect(observation).toMatchObject({ scoreEligible: true, completionRatio: 1 });
    expect(observation.capacityCurve).toEqual([{ requestedNotionalUsd: 1_000_000, maxCostBps: 200, executableUsd: 1_000_000, completionRatio: 1, executionCostBps: 0 }]);
    expect(resolveV9ExitCapacityAtRequest(observation.capacityCurve!.map(point => ({ ...point, executionCostBps: point.executionCostBps! })), request)?.completionRatio).toBe(1);
    const certificate = observation.executionCertificate!;
    expect(certificate.points).toHaveLength(envelope.policy.semantic.exit.stressRequest.notionalGridUsd.length);
    expect(certificate.points.find(point => point.requestedNotionalUsd === 10_000_000))
      .toMatchObject({ executableUsd: 40_000, certification: "exact-lower-bound" });
    const changedRequest = selectV9ExitStressRequest(210_000_000, envelope)!;
    expect(admitExitExecutionCertificate({ certificate, envelope, assetId: call.assetId, clockSec: CLOCK,
      request: changedRequest, reviews: [review], observationGenerationId: certificate.observationGenerationId,
      inputGenerationId: exitExecutionInputGenerationId(call.assetId, changedRequest, certificate.inputReference) }))
      .toMatchObject({ state: "unavailable", reason: "execution-generation-mismatch" });
  });
  it("does not upgrade a smaller canonical execution or a failed canonical receipt", async () => {
    state.canonicalCompletion = 0.04;
    const partial = (await observeReviewedExitExecutionRoutes(call)).observations[0]!;
    expect(partial).toMatchObject({ completionRatio: 0.04, scoreEligible: true });
    expect(partial.executionCertificate!.points.find(point => point.requestedNotionalUsd === 1_000_000)!.certification).toBe("exact-lower-bound");
    state.canonicalCompletion = 0; state.diagnostic = true;
    const failed = await observeReviewedExitExecutionRoutes(call);
    expect(failed.observations[0]).toMatchObject({ completionRatio: 0, scoreEligible: false, settlementBoundUnproven: true });
    expect(failed.failures).not.toEqual([]);
  });
});
