import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_META_BY_ID, ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { BridgeRouteRiskProfile, StablecoinMeta } from "@shared/types/core";
import { ReviewedEconomicSupplyPlanFileSchema, ReviewedEconomicSupplyPlanSchema, type ReviewedEconomicSupplyPlan, type EconomicSupplyObservation } from "@shared/types/safety-score-v9-supply-attribution";
import type { SafetyScoreV9ReviewedTransferFact } from "@shared/types/safety-score-v9-transfer-overlays";
import reviewRegistry from "@shared/data/safety-score-v9/supply-attribution-reviews-v1.json";
import { deriveReviewedEconomicDeploymentPartition, buildReviewedEconomicDeploymentInventory, hasCompleteEligibleProviderSupply, REVIEWED_ECONOMIC_SUPPLY_PLANS, reviewedSupplyRouteKind } from "../safety-score-v9/supply-attribution-contract";
import { buildSafetyScoreV9SupplyReview } from "../safety-score-v9/extension-supply";
import { transferMaterialScopeFromEconomicDeploymentPartition } from "../safety-score-v9/transfer-materiality";
import { resolveSafetyScoreV9ReviewedTransferFact } from "../safety-score-v9/extension-transfer";
import { makeV9FixedInput } from "../../test-helpers/v9-fixed-input";

const CLOCK = 1790850000;
const CANONICAL = `ethereum:0x${"1".repeat(40)}`;
const REMOTE = `base:0x${"2".repeat(40)}`;
const pendingSource = { sourceId: "pending", url: "https://issuer.example/pending", amountPath: ["amount"], observedAtPath: ["observedAt"], generationPath: ["generation"] };
function fixture() {
  const plan: ReviewedEconomicSupplyPlan = {
    assetId: "alpha", reviewer: "reviewer", reviewedAtSec: CLOCK - 86400, expiresAtSec: CLOCK + 86400,
    evidenceUrls: ["https://issuer.example/accounting"], economicScope: "All circulating holder claims; excludes the listed treasury and duplicate backing",
    sourceId: "reference", accountingFamily: "lock-mint", commonClaimUnit: "claim", exhaustive: true, inFlightTreatment: "observed-reconciled",
    deployments: [
      { deploymentKey: CANONICAL, chainId: "ethereum", address: CANONICAL.split(":")[1]!, holdingKind: "contract", amountBasis: "fixed-token-units", decimals: 6, routeId: CANONICAL, read: { kind: "evm-total-supply", safeBlockLag: 2 }, claimUnit: "claim", conversionSourceId: null },
      { deploymentKey: REMOTE, chainId: "base", address: REMOTE.split(":")[1]!, holdingKind: "contract", amountBasis: "fixed-token-units", decimals: 18, routeId: REMOTE, read: { kind: "evm-total-supply", safeBlockLag: 2 }, claimUnit: "claim", conversionSourceId: null },
    ],
    excludedRegistryDeploymentKeys: [], exclusions: [], conversionSources: [], referencePriceSource: null, liabilityInFlightSource: null,
    escrows: [{ id: "bridge-escrow", canonicalDeploymentKey: CANONICAL, account: `0x${"3".repeat(40)}`, receiptDeploymentKeys: [REMOTE], receiptClaimSources: [], independentReceiptLiability: false, inFlightSource: pendingSource }],
  };
  const routes = plan.deployments.map(row => ({ id: row.deploymentKey, destinationChain: row.chainId, contractAddress: row.address!, protocol: "bridge", issuanceModel: "bridge-representation", routeClass: "canonical", riskTier: "external-validated-network", semantics: "lock-mint", scope: "peripheral", reviewDisposition: "reviewed" })) as NonNullable<BridgeRouteRiskProfile["routes"]>;
  const meta = { contracts: plan.deployments.map(row => ({ chain: row.chainId, address: row.address!, decimals: row.decimals! })), bridgeRouteRisk: { tier: "external-validated-network", summary: "Reviewed exact bridge paths", routes } } as Pick<StablecoinMeta, "contracts" | "bridgeRouteRisk">;
  const observation = (id: string, deploymentKey: string, amount: string): EconomicSupplyObservation => ({ id, deploymentKey, amount, observedAtSec: CLOCK - 60, anchor: "100", anchorHash: `0x${"a".repeat(64)}`, responseSha256: "b".repeat(64) });
  return { plan, meta, baseInputGenerationId: `report-cards-input:v1:${"c".repeat(64)}`, sourceGeneration: "source", registryFingerprint: "d".repeat(64), clockSec: CLOCK,
    aggregate: { supplyUsd: 100, sourceGeneration: "source", observedAtSec: CLOCK - 60 },
    referencePrice: { sourceId: "reference", sourceGeneration: "price", observedAtSec: CLOCK - 60, value: "1", responseSha256: "e".repeat(64) }, conversions: [],
    observations: [observation(CANONICAL, CANONICAL, "100000000"), observation(REMOTE, REMOTE, "20000000000000000000"), observation("bridge-escrow", CANONICAL, "20000000")],
    inFlight: [observation("in-flight:bridge-escrow", CANONICAL, "0")],
  };
}
afterEach(() => vi.restoreAllMocks());

describe("reviewed economic supply accounting", () => {
  it("deduplicates 20 escrow-backed receipt claims from 100 canonical units", () => {
    const packet = deriveReviewedEconomicDeploymentPartition(fixture())!;
    expect(packet.deployments.map(row => row.currentSupplyUsd)).toEqual([80, 20]);
    expect(packet.aggregate.supplyUsd).toBe(100);
    expect(packet.unattributedSupplyUsd).toBe(0);
  });
  it("retains independently issued remote liability without subtracting it as a receipt", () => {
    const input = fixture(); input.plan.escrows = []; input.plan.accountingFamily = "independent-liability";
    input.observations.pop(); input.inFlight = [];
    const rows = deriveReviewedEconomicDeploymentPartition(input)!.deployments;
    expect(rows[0]!.currentSupplyUsd).toBeCloseTo(100 * 5 / 6);
    expect(rows[1]!.currentSupplyUsd).toBeCloseTo(100 / 6);
  });
  it("reconciles only verified escrow-backed subsets when a destination also issues independent liabilities", () => {
    const input = fixture();
    input.observations[1]!.amount = "50000000000000000000";
    input.plan.escrows[0]!.receiptClaimSources = [{ deploymentKey: REMOTE, source: pendingSource }];
    input.observations.push({ ...input.observations[1]!, id: `receipt:bridge-escrow:${REMOTE}`, amount: "20000000000000000000" });
    const packet = deriveReviewedEconomicDeploymentPartition(input)!;
    expect(packet.deployments[0]!.currentSupplyUsd).toBeCloseTo(100 * 80 / 130);
    expect(packet.deployments[1]!.currentSupplyUsd).toBeCloseTo(100 * 50 / 130);
    input.observations.pop();
    expect(deriveReviewedEconomicDeploymentPartition(input)).toBeNull();
  });
  it.each(["missing escrow", "receipt exceeds backing", "negative free", "missing pending", "duplicate escrow"])("rejects %s rather than granting allocation relief", failure => {
    const input = fixture();
    if (failure === "missing escrow") input.observations.pop();
    if (failure === "receipt exceeds backing") input.observations[1]!.amount = "21000000000000000000";
    if (failure === "negative free") input.observations[0]!.amount = "19000000";
    if (failure === "missing pending") input.inFlight = [];
    if (failure === "duplicate escrow") input.plan.escrows.push(structuredClone(input.plan.escrows[0]!));
    expect(deriveReviewedEconomicDeploymentPartition(input)).toBeNull();
  });
  it("keeps a quantitatively bounded in-flight remainder out of canonical free float", () => {
    const input = fixture(); input.observations[1]!.amount = "19000000000000000000"; input.inFlight[0]!.amount = "1000000";
    const packet = deriveReviewedEconomicDeploymentPartition(input)!;
    expect(packet.deployments.map(row => row.currentSupplyUsd)).toEqual([80, 19]);
    expect(packet.unattributedSupplyUsd).toBe(1);
  });
  it("keeps excluded receipts in escrow conservation while removing them from circulating allocation", () => {
    const input = fixture();
    input.plan.exclusions = [{ id: "receipt-treasury", deploymentKey: REMOTE, account: `0x${"4".repeat(40)}` }];
    input.observations.push({ ...input.observations[1]!, id: "receipt-treasury", amount: "5000000000000000000" });
    const packet = deriveReviewedEconomicDeploymentPartition(input)!;
    expect(packet.deployments[0]!.currentSupplyUsd).toBeCloseTo(100 * 80 / 95);
    expect(packet.deployments[1]!.currentSupplyUsd).toBeCloseTo(100 * 15 / 95);
    input.observations[2]!.amount = "15000000";
    expect(deriveReviewedEconomicDeploymentPartition(input)).toBeNull();
  });
  it.each(["number", "hash", "time"])("rejects on-chain pending with a different canonical generation %s", mismatch => {
    const input = fixture();
    input.plan.escrows[0]!.inFlightSource = { kind: "evm-pending-state", sourceId: "pending", chainId: "ethereum",
      bridgeAddress: `0x${"3".repeat(40)}`, bridgeRuntimeCodeSha256: "f".repeat(64), finality: "finalized",
      messageCountSelector: "0x11111111", messageIdSelector: "0x22222222", pendingAmountSelector: "0x33333333", messageIds: [] };
    expect(deriveReviewedEconomicDeploymentPartition(input)).not.toBeNull();
    if (mismatch === "number") input.inFlight[0]!.anchor = "101";
    if (mismatch === "hash") input.inFlight[0]!.anchorHash = `0x${"f".repeat(64)}`;
    if (mismatch === "time") input.inFlight[0]!.observedAtSec--;
    expect(deriveReviewedEconomicDeploymentPartition(input)).toBeNull();
  });
  it("preserves tiny nonzero receipts and distinguishes an observed zero from an absent row", () => {
    const input = fixture(); input.plan.escrows = []; input.plan.accountingFamily = "independent-liability"; input.observations.pop(); input.inFlight = [];
    input.observations[1]!.amount = "101";
    expect(deriveReviewedEconomicDeploymentPartition(input)!.deployments[1]!.currentSupplyUsd).toBeGreaterThan(0);
    input.observations[1]!.amount = "0";
    expect(deriveReviewedEconomicDeploymentPartition(input)!.deployments[1]!.currentSupplyUsd).toBe(0);
    input.observations.pop();
    expect(deriveReviewedEconomicDeploymentPartition(input)).toBeNull();
  });
  it.each([1800, 1801])("admits observations through the exact %s-second age boundary", age => {
    const input = fixture(); input.observations.forEach(row => row.observedAtSec = CLOCK - age); input.inFlight.forEach(row => row.observedAtSec = CLOCK - age);
    expect(deriveReviewedEconomicDeploymentPartition(input) === null).toBe(age > 1800);
  });
  it.each([120, 121])("enforces the %s-second cross-observation skew boundary", skew => {
    const input = fixture(); input.observations[0]!.observedAtSec -= skew;
    expect(deriveReviewedEconomicDeploymentPartition(input) === null).toBe(skew > 120);
  });
  it("rejects stale price, forged block hash and catalog expansion outside the plan", () => {
    const stale = fixture(); stale.referencePrice.observedAtSec = CLOCK - 1801;
    expect(deriveReviewedEconomicDeploymentPartition(stale)).toBeNull();
    const badHash = fixture(); badHash.observations[0]!.anchorHash = "not-a-block";
    expect(deriveReviewedEconomicDeploymentPartition(badHash)).toBeNull();
    const expanded = fixture(); expanded.meta.contracts!.push({ chain: "optimism", address: `0x${"4".repeat(40)}`, decimals: 18 });
    expect(buildReviewedEconomicDeploymentInventory("alpha", expanded.plan, expanded.meta)).toBeNull();
  });
  it("does not certify a missing deployment zero even when the visible provider subtotal equals aggregate", () => {
    const input = fixture();
    const source = { clockSec: CLOCK, aggregateCirculatingById: { alpha: { circulating: { peggedUSD: 100 }, observedAtSec: CLOCK - 60 } }, chainCirculatingById: { alpha: { ethereum: { current: 100 } } } };
    expect(hasCompleteEligibleProviderSupply(source, "alpha", input.meta)).toBe(false);
    source.chainCirculatingById.alpha = { ethereum: { current: 80 }, base: { current: 20 } } as typeof source.chainCirculatingById.alpha;
    expect(hasCompleteEligibleProviderSupply(source, "alpha", input.meta)).toBe(true);
  });
  it("activates exhaustive provider reconciliation only with a reviewed economic plan", () => {
    const input = fixture();
    const fixed = makeV9FixedInput({ assetId: "alpha", clockSec: CLOCK });
    fixed.aggregateCirculatingById = { alpha: { circulating: { peggedUSD: 120 }, observedAtSec: CLOCK - 60 } };
    const chainTemplate = fixed.chainCirculatingById.alpha!.ethereum!;
    fixed.chainCirculatingById = { alpha: { ethereum: { ...chainTemplate, current: 80 }, base: { ...chainTemplate, current: 20 } } };
    vi.spyOn(ACTIVE_META_BY_ID, "get").mockReturnValue(input.meta as StablecoinMeta);

    // Without new reviewed data, captured rows keep their established base.
    const legacy = buildSafetyScoreV9SupplyReview(fixed, "alpha", input.meta.bridgeRouteRisk)!;
    expect(legacy.selectedBridgeRoutes.map(row => row.supplyShare)).toEqual([0.2, 0.8]);
    expect(legacy.selectedRouteSupplyShare).toBe(1);

    vi.spyOn(REVIEWED_ECONOMIC_SUPPLY_PLANS, "has").mockImplementation(assetId => assetId === "alpha");
    vi.spyOn(REVIEWED_ECONOMIC_SUPPLY_PLANS, "get").mockReturnValue(input.plan);
    expect(buildSafetyScoreV9SupplyReview(fixed, "alpha", input.meta.bridgeRouteRisk)).toBeNull();
    fixed.aggregateCirculatingById.alpha!.circulating.peggedUSD = 100;
    expect(buildSafetyScoreV9SupplyReview(fixed, "alpha", input.meta.bridgeRouteRisk)!.selectedBridgeRoutes
      .map(row => row.supplyShare)).toEqual([0.2, 0.8]);
    delete fixed.chainCirculatingById.alpha!.base;
    expect(buildSafetyScoreV9SupplyReview(fixed, "alpha", input.meta.bridgeRouteRisk)).toBeNull();
  });
  it("rejects duplicate reviewed identities at the shared schema boundary", () => {
    const plan = fixture().plan; plan.deployments.push(structuredClone(plan.deployments[0]!));
    expect(ReviewedEconomicSupplyPlanSchema.safeParse(plan).success).toBe(false);
  });
  it("keeps native liabilities controlled when an exact NTT/OFT acceptance path applies", () => {
    const profile = structuredClone(ACTIVE_META_BY_ID.get("xdai-gnosis")!.bridgeRouteRisk!);
    const route = { ...profile.routes![0]!, routeClass: "native" as const, semantics: "native-mint" as const, issuanceModel: "native-issuance" as const };
    expect(reviewedSupplyRouteKind(route, profile)).toBe("controlled");
    expect(reviewedSupplyRouteKind(route, { controls: [] })).toBe("native");
  });
});

describe("economic materiality consumers", () => {
  it("grants exact below-threshold transfer scope and fails closed on a changed binding", () => {
    const input = fixture(); input.observations[1]!.amount = "5000000000000000000"; input.observations[2]!.amount = "5000000";
    const packet = deriveReviewedEconomicDeploymentPartition(input)!;
    vi.spyOn(REVIEWED_ECONOMIC_SUPPLY_PLANS, "get").mockReturnValue(input.plan);
    vi.spyOn(ACTIVE_META_BY_ID, "get").mockReturnValue(input.meta as StablecoinMeta);
    const fixed = makeV9FixedInput({ assetId: "alpha", clockSec: CLOCK });
    Object.assign(fixed, { baseInputGenerationId: input.baseInputGenerationId, sourceGeneration: input.sourceGeneration, registryFingerprint: input.registryFingerprint,
      aggregateCirculatingById: { alpha: { circulating: { peggedUSD: 100 }, observedAtSec: CLOCK - 60 } }, chainCirculatingById: {}, navPriceById: { alpha: { sourceId: "reference", priceUsd: 1, observedAtSec: CLOCK - 60, confidence: "high" } }, safetyScoreV9SupplyAttributionById: { alpha: packet } });
    const baseScope = { authoritativeDeploymentKeys: [CANONICAL, REMOTE], materialDeploymentKeys: [], materialDeploymentScopeComplete: false, deploymentModel: "contract-addressable" as const };
    const scope = transferMaterialScopeFromEconomicDeploymentPartition({ assetId: "alpha", fixedInput: fixed, baseScope });
    expect(scope.materialDeploymentKeys).toEqual([CANONICAL]);
    expect(scope.materialDeploymentScopeComplete).toBe(true);
    expect(buildSafetyScoreV9SupplyReview(fixed, "alpha", input.meta.bridgeRouteRisk)!.selectedBridgeRoutes.map(row => row.supplyUsd)).toEqual([5, 95]);
    fixed.baseInputGenerationId = `report-cards-input:v1:${"f".repeat(64)}`;
    expect(transferMaterialScopeFromEconomicDeploymentPartition({ assetId: "alpha", fixedInput: fixed, baseScope }).materialDeploymentScopeComplete).toBe(false);
    expect(buildSafetyScoreV9SupplyReview(fixed, "alpha", input.meta.bridgeRouteRisk)).toBeNull();
  });
  it("cannot substitute a safe WXDAI review for the independently material native xDAI surface", () => {
    const review: SafetyScoreV9ReviewedTransferFact = { assetId: "alpha", reviewer: "reviewer", reviewedAt: "2026-09-30", deployments: [{ chainId: "gnosis", contractOrTokenId: `0x${"1".repeat(40)}`, scope: "canonical", posture: "permissionless", evidence: "Immutable wrapper only", sources: [{ label: "primary", url: "https://issuer.example" }] }] };
    const nativeKey = "gnosis:native:xdai";
    const scope = { authoritativeDeploymentKeys: [nativeKey, `gnosis:0x${"1".repeat(40)}`], materialDeploymentKeys: [nativeKey], materialDeploymentScopeComplete: true, deploymentModel: "mixed-economic" as const, reviewedNativeDeploymentKeys: [nativeKey] };
    expect(resolveSafetyScoreV9ReviewedTransferFact(review, CLOCK, scope).posture).toBeNull();
    review.deployments.push({ ...review.deployments[0]!, contractOrTokenId: "native:xdai", posture: "restrictable" });
    expect(resolveSafetyScoreV9ReviewedTransferFact(review, CLOCK, scope).posture).toBe("restrictable");
  });
  it("guards existing independent-liability eligibility against registry and route drift", () => {
    for (const assetId of ReviewedEconomicSupplyPlanFileSchema.parse(reviewRegistry).independentLiabilityAssetIds) {
      const meta = ACTIVE_META_BY_ID.get(assetId)!;
      expect(meta).toBeDefined();
      expect(meta.bridgeRouteRisk!.routes!.every(route => route.semantics === "burn-mint" ||
        (route.semantics === "native-mint" && route.issuanceModel === "native-issuance"))).toBe(true);
    }
  });
  it("guards every registry-authored native single-route entry and preserves xDAI's compiled partition", () => {
    const registry = ReviewedEconomicSupplyPlanFileSchema.parse(reviewRegistry);
    for (const entry of registry.nativeSingleRouteReviews) {
      const meta = ACTIVE_STABLECOINS.find(coin => coin.id === entry.assetId)!;
      expect(meta?.bridgeRouteRisk?.routes?.map(route => route.id)).toEqual([entry.routeId]);
      expect(meta.bridgeRouteRisk!.routes![0]!.reviewDisposition).toBe("reviewed");
      const fixed = makeV9FixedInput({ assetId: entry.assetId, clockSec: CLOCK });
      fixed.chainCirculatingById[entry.assetId] = {};
      fixed.safetyScoreV9SupplyAttributionById = {};
      fixed.aggregateCirculatingById[entry.assetId] = { circulating: { peggedUSD: 100 }, observedAtSec: CLOCK - 60 };
      const result = buildSafetyScoreV9SupplyReview(fixed, entry.assetId, meta.bridgeRouteRisk)!;
      const expected = { selectedBridgeRoutes: [{ deploymentRouteKey: entry.routeId, supplyUsd: 100, supplyShare: 1, reviewState: "selected-reviewed", reviewedRouteKind: "controlled" }], selectedRouteSupplyShare: 1, unknownRouteSupplyShare: 0, unreviewedRouteSupplyShare: 0,
        failureDomains: [...new Set(meta.bridgeRouteRisk!.routes![0]!.failureDomainKeys ?? [entry.routeId])].sort().map(key => ({ kind: "bridge-route", key })) };
      expect(JSON.stringify(result)).toBe(JSON.stringify(expected));
      fixed.clockSec = Date.parse(entry.reviewedAt) / 1000 - 1;
      expect(buildSafetyScoreV9SupplyReview(fixed, entry.assetId, meta.bridgeRouteRisk)).toBeNull();
    }
  });
});
