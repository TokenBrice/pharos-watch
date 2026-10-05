import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_META_BY_ID, ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { BridgeRouteRiskProfile, StablecoinMeta } from "@shared/types/core";
import { resolveChainId } from "@shared/types/chain-identity";
import { isFixedDecimalDeployment } from "@shared/lib/deployment-amounts";
import { ReviewedEconomicSupplyPlanFileSchema, ReviewedEconomicSupplyPlanSchema, type ReviewedEconomicSupplyPlan, type ReviewedEconomicDeploymentPartition, type EconomicSupplyReference, type EconomicSupplyObservation } from "@shared/types/safety-score-v9-supply-attribution";
import type { SafetyScoreV9ReviewedTransferFact } from "@shared/types/safety-score-v9-transfer-overlays";
import reviewRegistry from "@shared/data/safety-score-v9/supply-attribution-reviews-v1.json";
import { deriveReviewedEconomicDeploymentPartition, buildReviewedEconomicDeploymentInventory, hasCompleteEligibleProviderSupply, loadReviewedEconomicSupplyPlans, REVIEWED_ECONOMIC_SUPPLY_PLANS, REVIEWED_ECONOMIC_SUPPLY_PLAN_QUARANTINES, reviewedEconomicDeploymentAttributionValidationError, reviewedSupplyRouteKind } from "../safety-score-v9/supply-attribution-contract";
import { buildSafetyScoreV9SupplyReview } from "../safety-score-v9/extension-supply";
import { transferMaterialScopeFromEconomicDeploymentPartition } from "../safety-score-v9/transfer-materiality";
import { resolveSafetyScoreV9ReviewedTransferFact } from "../safety-score-v9/extension-transfer";
import { makeV9FixedInput } from "../../test-helpers/v9-fixed-input";
import type * as SupplyAttributionContract from "../safety-score-v9/supply-attribution-contract";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { chainRpcs } from "./safety-score-v9-supply-observation.test-support";
import { createSupplyAttributionJournalV1 } from "@shared/lib/safety-score-v9-supply-attribution-journal";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import type { SafetyScoreV9CompilerInput } from "../safety-score-v9/native-input";
import type * as SupplyAttributionGeneration from "../safety-score-v9/supply-attribution-generation";
import { normalizeFixedInput } from "../report-cards-fixed-input";
import { ReviewedProviderChainPartitionSchema } from "@shared/types/safety-score-v9-supply-attribution";
import { REVIEWED_PROVIDER_CHAIN_PARTITIONS, deriveReviewedProviderChainPartition } from "../safety-score-v9/supply-attribution-contract";
import { createSafetyScoreV9TransferMaterialityGeneration, exactInputBoundTransferMaterialityPacket, type SafetyScoreV9TransferMaterialityObservation } from "../safety-score-v9/transfer-materiality";

const CLOCK = 1790850000;
const CANONICAL = `ethereum:0x${"1".repeat(40)}`;
const REMOTE = `base:0x${"2".repeat(40)}`;
const pendingSource = { sourceId: "pending", url: "https://issuer.example/pending", amountPath: ["amount"], observedAtPath: ["observedAt"], generationPath: ["generation"] };

interface EconomicFixture {
  plan: ReviewedEconomicSupplyPlan;
  meta: Pick<StablecoinMeta, "contracts" | "bridgeRouteRisk">;
  baseInputGenerationId: string;
  sourceGeneration: string;
  registryFingerprint: string;
  clockSec: number;
  aggregate: ReviewedEconomicDeploymentPartition["aggregate"];
  referencePrice: EconomicSupplyReference;
  conversions: EconomicSupplyReference[];
  observations: EconomicSupplyObservation[];
  inFlight: EconomicSupplyObservation[];
}

function fixture(): EconomicFixture {
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

function independentFixture(): EconomicFixture {
  const input = fixture();
  input.plan.accountingFamily = "independent-liability";
  input.plan.escrows = [];
  input.observations.pop();
  input.inFlight = [];
  input.meta.bridgeRouteRisk!.routes!.forEach(route =>
    Object.assign(route, { semantics: "native-mint", routeClass: "native", issuanceModel: "native-issuance" }));
  return input;
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
    const input = independentFixture();
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
  it.each(["duplicate", "escrow overlap"])("rejects %s balance deduction identities", failure => {
    const input = fixture();
    const escrow = input.plan.escrows[0]!;
    const rule = { id: "treasury-a", deploymentKey: failure === "duplicate" ? REMOTE : CANONICAL,
      account: failure === "duplicate" ? `0x${"4".repeat(40)}` : escrow.account };
    input.plan.exclusions = [rule, ...(failure === "duplicate" ? [{ ...rule, id: "treasury-b" }] : [])];
    input.observations.push(...input.plan.exclusions.map(row => ({ ...input.observations[failure === "duplicate" ? 1 : 0]!, id: row.id, amount: "0" })));
    expect(ReviewedEconomicSupplyPlanSchema.safeParse(input.plan).success).toBe(false);
    expect(deriveReviewedEconomicDeploymentPartition(input)).toBeNull();
  });
  it.each(["number", "hash", "time"])("rejects API-pending escrow from a different EVM snapshot %s", mismatch => {
    const input = fixture(), escrow = input.observations[2]!;
    if (mismatch === "number") escrow.anchor = "99";
    if (mismatch === "hash") escrow.anchorHash = `0x${"f".repeat(64)}`;
    if (mismatch === "time") escrow.observedAtSec--;
    expect(deriveReviewedEconomicDeploymentPartition(input)).toBeNull();
  });
  it("joins excluded holders to the deployment's exact EVM snapshot", () => {
    const input = fixture();
    input.plan.exclusions = [{ id: "treasury", deploymentKey: CANONICAL, account: `0x${"4".repeat(40)}` }];
    const balance = { ...input.observations[0]!, id: "treasury", amount: "1000000" };
    input.observations.push(balance);
    expect(deriveReviewedEconomicDeploymentPartition(input)!.deployments[0]!.currentSupplyUsd).toBeCloseTo(100 * 79 / 99);
    balance.anchor = "99";
    expect(deriveReviewedEconomicDeploymentPartition(input)).toBeNull();
  });
  it("joins native-gas exclusions and escrows at one chain-state anchor without confusing the aggregate for state", () => {
    const input = fixture(), native = input.plan.deployments[0]!;
    const nativeKey = "ethereum:native:ether";
    Object.assign(native, { deploymentKey: nativeKey, address: "ether", routeId: null, holdingKind: "native-gas", amountBasis: "native-ledger", decimals: null, read: { kind: "native-from-aggregate", safeBlockLag: 2 } });
    input.meta.contracts!.shift();
    input.plan.escrows[0]!.canonicalDeploymentKey = nativeKey;
    Object.assign(input.observations[0]!, { id: nativeKey, deploymentKey: nativeKey, amount: "100", anchor: "attributed:source", anchorHash: "a".repeat(64) });
    Object.assign(input.observations[2]!, { deploymentKey: nativeKey, amount: "20" });
    input.inFlight[0]!.deploymentKey = nativeKey;
    input.plan.exclusions = [{ id: "native-treasury", deploymentKey: nativeKey, account: `0x${"4".repeat(40)}` }];
    const balance = { ...input.observations[2]!, id: "native-treasury", amount: "1" };
    input.observations.push(balance);
    expect(deriveReviewedEconomicDeploymentPartition(input)!.deployments[0]!.currentSupplyUsd).toBeCloseTo(100 * 79 / 99);
    balance.anchorHash = `0x${"f".repeat(64)}`;
    expect(deriveReviewedEconomicDeploymentPartition(input)).toBeNull();
  });
  it("quarantines malformed plan evidence without blocking unrelated attribution", () => {
    const input = fixture(), bad = structuredClone(input.plan);
    bad.assetId = "beta";
    bad.deployments[0]!.decimals = null;
    const authored = { ...reviewRegistry, reviews: [input.plan, bad] };
    expect(ReviewedEconomicSupplyPlanFileSchema.safeParse(authored).success).toBe(false);
    const loaded = loadReviewedEconomicSupplyPlans(authored);
    expect([...loaded.plans.keys()]).toEqual(["alpha"]);
    expect(loaded.quarantines.get("beta")).toMatchObject({ name: "ReviewedRegistryEntryError", path: "supplyAttribution.reviews.1.deployments.0" });
    vi.spyOn(REVIEWED_ECONOMIC_SUPPLY_PLAN_QUARANTINES, "get").mockImplementation(id => loaded.quarantines.get(id));
    const fixed = makeV9FixedInput({ assetId: "alpha", clockSec: CLOCK });
    expect(() => buildSafetyScoreV9SupplyReview(fixed, "beta", input.meta.bridgeRouteRisk)).toThrow("Only fixed token units have fixed decimals");
    expect(deriveReviewedEconomicDeploymentPartition(input)!.deployments.map(row => row.currentSupplyUsd)).toEqual([80, 20]);
  });
  it("quarantines duplicate asset plans without suppressing another admitted asset", () => {
    const plan = fixture().plan;
    const loaded = loadReviewedEconomicSupplyPlans({ ...reviewRegistry, reviews: [plan, structuredClone(plan), { ...plan, assetId: "beta" }] });
    expect([...loaded.plans.keys()]).toEqual(["beta"]);
    expect(loaded.quarantines.get("alpha")).toMatchObject({ name: "ReviewedRegistryEntryError" });
  });
  it("validates provider alias totals rather than individual label fragments", () => {
    const input = fixture(), attribution = deriveReviewedEconomicDeploymentPartition(input)!;
    vi.spyOn(REVIEWED_ECONOMIC_SUPPLY_PLANS, "get").mockReturnValue(input.plan);
    vi.spyOn(ACTIVE_META_BY_ID, "get").mockReturnValue(input.meta as StablecoinMeta);
    const validate = (chainRows: Record<string, { current: number }>) => reviewedEconomicDeploymentAttributionValidationError({
      assetId: "alpha", attribution, aggregateSupplyUsd: 100, registryFingerprint: input.registryFingerprint, clockSec: CLOCK, chainRows,
    });
    expect(validate({ Ethereum: { current: 60 }, ethereum: { current: 20 }, Base: { current: 20 } })).toBeNull();
    expect(validate({ Ethereum: { current: 60 }, ethereum: { current: 10 }, Base: { current: 20 } })).toBe("Economic supply attribution contradicts eligible provider chain");
    for (const current of [NaN, Infinity, -1]) expect(validate({ ethereum: { current } })).toBe("Economic supply attribution contradicts eligible provider chain");
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
    const input = independentFixture();
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
    const input = fixture(); input.observations[1]!.observedAtSec -= skew;
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
  it("rejects a lock-mint route relabelled as independent supply, even with a pending API", () => {
    const input = independentFixture();
    input.meta.bridgeRouteRisk!.routes![1]!.semantics = "lock-mint";
    expect(ReviewedEconomicSupplyPlanSchema.safeParse(input.plan).success).toBe(true);
    expect(buildReviewedEconomicDeploymentInventory("alpha", input.plan, input.meta)).toBeNull();
    input.plan.liabilityInFlightSource = pendingSource;
    expect(buildReviewedEconomicDeploymentInventory("alpha", input.plan, input.meta)).toBeNull();
  });
  it("admits native-only multichain liabilities without manufacturing pending messages", () => {
    const input = independentFixture();
    expect(buildReviewedEconomicDeploymentInventory("alpha", input.plan, input.meta)).not.toBeNull();
    expect(deriveReviewedEconomicDeploymentPartition(input)!.inFlight).toEqual([]);
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
  it.each(["unresolved", "missing"] as const)(
    "keeps an %s economic route and in-flight liability out of reviewed supply",
    (disposition) => {
      const input = fixture();
      input.observations[1]!.amount = "19000000000000000000";
      input.inFlight[0]!.amount = "1000000";
      const packet = deriveReviewedEconomicDeploymentPartition(input)!;
      vi.spyOn(REVIEWED_ECONOMIC_SUPPLY_PLANS, "get").mockReturnValue(input.plan);
      vi.spyOn(ACTIVE_META_BY_ID, "get").mockReturnValue(input.meta as StablecoinMeta);
      const fixed = makeV9FixedInput({ assetId: "alpha", clockSec: CLOCK });
      Object.assign(fixed, {
        baseInputGenerationId: input.baseInputGenerationId,
        sourceGeneration: input.sourceGeneration,
        registryFingerprint: input.registryFingerprint,
        aggregateCirculatingById: { alpha: { circulating: { peggedUSD: 100 }, observedAtSec: CLOCK - 60 } },
        chainCirculatingById: {},
        navPriceById: { alpha: { sourceId: "reference", priceUsd: 1, observedAtSec: CLOCK - 60, confidence: "high" } },
        safetyScoreV9SupplyAttributionById: { alpha: packet },
      });
      const profile = structuredClone(input.meta.bridgeRouteRisk!);
      if (disposition === "missing") profile.routes!.pop();
      else profile.routes![1]!.reviewDisposition = "unresolved";
      const review = buildSafetyScoreV9SupplyReview(fixed, "alpha", profile)!;
      expect(review.selectedRouteSupplyShare).toBe(0.8);
      expect(review.unreviewedRouteSupplyShare).toBe(disposition === "missing" ? 0 : 0.19);
      expect(review.unknownRouteSupplyShare).toBe(disposition === "missing" ? 0.2 : 0.01);
      expect(review.selectedBridgeRoutes).toEqual(expect.arrayContaining([
        { deploymentRouteKey: disposition === "missing" ? `unmatched-economic:alpha:${REMOTE}` : REMOTE,
          supplyUsd: 19, supplyShare: 0.19, reviewState: disposition === "missing" ? "unmatched" : "selected-unresolved" },
        { deploymentRouteKey: "unmatched-economic:alpha:in-flight", supplyUsd: 1, supplyShare: 0.01, reviewState: "unmatched" },
      ]));
      expect(review.failureDomains).toContainEqual({ kind: "bridge-route", key: "unmatched-economic:alpha:in-flight" });
    },
  );

  it("captures reviewed economic liabilities with an auditable journal and a bounded freshness window", async () => {
    const input = fixture();
    input.observations[1]!.amount = "19000000000000000000";
    input.inFlight[0]!.amount = "1000000";
    const packet = deriveReviewedEconomicDeploymentPartition(input)!;
    const fixed = makeV9FixedInput({ assetId: "alpha", clockSec: CLOCK });
    Object.assign(fixed, {
      baseInputGenerationId: input.baseInputGenerationId,
      sourceGeneration: input.sourceGeneration,
      registryFingerprint: input.registryFingerprint,
      aggregateCirculatingById: { alpha: { circulating: { peggedUSD: 100 }, observedAtSec: CLOCK - 60 } },
      chainCirculatingById: {},
    });
    // Descriptors and source membership snapshot the reviewed registry at module initialization.
    vi.resetModules();
    vi.doMock("../safety-score-v9/supply-attribution-contract", async (importOriginal) => ({
      ...await importOriginal<typeof SupplyAttributionContract>(),
      REVIEWED_ECONOMIC_SUPPLY_PLANS: new Map([[input.plan.assetId, input.plan]]),
    }));
    vi.doMock("../safety-score-v9/economic-supply-observer", () => ({
      observeReviewedEconomicDeploymentPartitionAttempt: async () => ({ status: "accepted", attribution: packet }),
    }));
    try {
      const { captureSafetyScoreV9SupplyAttribution, safetyScoreV9ChainRows, safetyScoreV9ChainSupplyMaxAgeSec } =
        await import("../safety-score-v9/supply-attribution");
      const capture = await captureSafetyScoreV9SupplyAttribution(fixed, chainRpcs());
      expect(capture.expectedAssetIds).toEqual(["alpha"]);
      expect(capture.journalRecords).toEqual([expect.objectContaining({
        assetId: "alpha", sourceOriginClass: "issuer-disclosure-plus-onchain",
        admissionCode: "supply-attribution.admission.accepted",
        fallbackCode: "supply-attribution.fallback.not-used",
        routeInventoryDigest: packet.routeInventoryDigest,
        sourceObservedAtSec: CLOCK - 60,
        contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      })]);
      const captured = { ...fixed, safetyScoreV9SupplyAttributionById: capture.attributionById };
      expect(safetyScoreV9ChainRows(captured, "alpha")).toEqual({
        ethereum: { current: 80 }, base: { current: 19 }, "unmatched-economic:alpha": { current: 1 },
      });
      expect(safetyScoreV9ChainSupplyMaxAgeSec(captured, "alpha", null)).toBe(
        V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution.observationMaxAgeSec,
      );
    } finally {
      vi.doUnmock("../safety-score-v9/supply-attribution-contract");
      vi.doUnmock("../safety-score-v9/economic-supply-observer");
      vi.resetModules();
    }
  });

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
      const routes = meta.bridgeRouteRisk!.routes!;
      expect(routes.every(route => route.reviewDisposition === "reviewed" && route.representationId === undefined &&
        (route.semantics === "burn-mint" && route.issuanceModel === "bridge-representation" && route.routeClass !== "native" ||
          route.semantics === "native-mint" && route.issuanceModel === "native-issuance" && route.routeClass === "native"))).toBe(true);
      const deployments = meta.contracts!.map(contract => {
        expect(isFixedDecimalDeployment(contract)).toBe(true);
        const chain = resolveChainId(contract.chain)!;
        return `${chain}:${chain === "solana" ? contract.address : contract.address.toLowerCase()}`;
      }).sort();
      expect(routes.map(route => route.id).sort()).toEqual(deployments);
      expect(new Set(deployments).size).toBe(deployments.length);
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

function rebindHandoffInput(fixedInput: SafetyScoreV9CompilerInput) {
  const { baseInputGenerationId: _baseInputGenerationId, ...payload } = fixedInput;
  return normalizeFixedInput({ ...payload, inputFreshness: {
    ...payload.inputFreshness, dexLiquidity: { ...payload.inputFreshness.dexLiquidity,
      ageSeconds: payload.clockSec - payload.inputFreshness.dexLiquidity.updatedAt! },
  } }, new Set(["alpha"]));
}

async function withEconomicHandoff(
  input: EconomicFixture,
  run: (context: {
    source: SafetyScoreV9CompilerInput;
    consumer: SafetyScoreV9CompilerInput;
    generation: SupplyAttributionGeneration.SafetyScoreV9SupplyAttributionGeneration;
    apply: typeof SupplyAttributionGeneration.applySafetyScoreV9SupplyAttributionGeneration;
  }) => void,
) {
  vi.resetModules();
  // Test module loading: plan membership is captured on import, so static
  // imports cannot exercise a different admitted registry in this test.
  vi.doMock("../safety-score-v9/supply-attribution-contract", async (importOriginal) => {
    const original = await importOriginal<typeof SupplyAttributionContract>();
    const plans = new Map([[input.plan.assetId, input.plan]]);
    vi.spyOn(original.REVIEWED_ECONOMIC_SUPPLY_PLANS, "get").mockImplementation(id => plans.get(id));
    const registry = await import("@shared/lib/stablecoins/registry");
    const get = registry.ACTIVE_META_BY_ID.get.bind(registry.ACTIVE_META_BY_ID);
    vi.spyOn(registry.ACTIVE_META_BY_ID, "get").mockImplementation(id => id === "alpha" ? input.meta as StablecoinMeta : get(id));
    const find = registry.ACTIVE_STABLECOINS.find.bind(registry.ACTIVE_STABLECOINS);
    const meta = { ...registry.ACTIVE_STABLECOINS[0]!, ...input.meta, id: "alpha",
      flags: { ...registry.ACTIVE_STABLECOINS[0]!.flags, navToken: true } };
    vi.spyOn(registry.ACTIVE_STABLECOINS, "find").mockImplementation(predicate =>
      predicate(meta, 0, registry.ACTIVE_STABLECOINS) ? meta : find(predicate));
    return { ...original, REVIEWED_ECONOMIC_SUPPLY_PLANS: plans };
  });
  try {
    const { createSafetyScoreV9SupplyAttributionGeneration: create, applySafetyScoreV9SupplyAttributionGeneration: apply } =
      await import("../safety-score-v9/supply-attribution-generation");
    const source = makeV9FixedInput({ assetId: "alpha", clockSec: CLOCK });
    Object.assign(source, { baseInputGenerationId: input.baseInputGenerationId, sourceGeneration: input.sourceGeneration,
      registryFingerprint: input.registryFingerprint, chainCirculatingById: {},
      aggregateCirculatingById: { alpha: { circulating: { peggedUSD: input.aggregate.supplyUsd }, observedAtSec: input.aggregate.observedAtSec } },
      navPriceById: { alpha: { sourceId: "reference", priceUsd: 1, observedAtSec: CLOCK - 60, confidence: "high" } } });
    const packet = deriveReviewedEconomicDeploymentPartition(input)!;
    const journal = createSupplyAttributionJournalV1({
      schemaVersion: 1, lane: "supply-attribution", assetId: "alpha", attemptId: "supply-attribution:economic-handoff",
      sourceId: V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution.journalSourceId,
      sourceOriginClass: "issuer-disclosure-plus-onchain", baseInputGenerationId: source.baseInputGenerationId,
      sourceGeneration: source.sourceGeneration, registryFingerprint: source.registryFingerprint,
      routeInventoryDigest: packet.routeInventoryDigest, attemptCode: "supply-attribution.collector.attempted",
      admissionCode: "supply-attribution.admission.accepted", fallbackCode: "supply-attribution.fallback.not-used",
      attemptedAtSec: CLOCK, completedAtSec: CLOCK + 1, scoringClockSec: input.clockSec,
      sourceObservedAtSec: packet.observedAtSec, failedRouteId: null, contentSha256: sha256Hex(stableJsonStringifyV1(packet)),
    });
    const generation = create({ fixedInput: source, capturedAtSec: Math.max(input.clockSec, CLOCK + 1),
      capture: { attributionById: { alpha: packet }, captureClockSec: input.clockSec, expectedAssetIds: ["alpha"], journalRecords: [journal] } });
    const consumer = structuredClone(source);
    Object.assign(consumer, { clockSec: CLOCK + 600, sourceGeneration: "consumer-source" });
    consumer.aggregateCirculatingById.alpha = { circulating: { peggedUSD: 200 }, observedAtSec: CLOCK + 600 };
    consumer.navPriceById!.alpha = { sourceId: "reference", priceUsd: 2, observedAtSec: CLOCK + 600, confidence: "high" };
    const applyConsumer: typeof apply = (fixedInput, captured) => {
      const normalized = rebindHandoffInput(fixedInput);
      Object.assign(fixedInput, normalized);
      return apply(normalized, captured);
    };
    Object.assign(consumer, rebindHandoffInput(consumer));
    run({ source, consumer, generation, apply: applyConsumer });
  } finally {
    vi.doUnmock("../safety-score-v9/supply-attribution-contract");
    vi.resetModules();
  }
}

describe("economic capture handoff", () => {
  it("re-derives raw observations against the exact consumer base, source, aggregate and price", async () => {
    await withEconomicHandoff(fixture(), ({ consumer, generation, apply }) => {
      const result = apply(consumer, generation);
      expect(result).toMatchObject({ status: "applied", acceptedAssetIds: ["alpha"], invalidAssetIds: [] });
      const packet = result.fixedInput.safetyScoreV9SupplyAttributionById.alpha!;
      if (packet.model !== "reviewed-economic-deployment-partition-v1") throw new Error("Expected economic packet");
      expect(packet).toMatchObject({ baseInputGenerationId: consumer.baseInputGenerationId, sourceGeneration: "consumer-source",
        scoringClockSec: consumer.clockSec, aggregate: { supplyUsd: 200, observedAtSec: CLOCK + 600, sourceGeneration: "consumer-source" },
        referencePrice: { value: "2", observedAtSec: CLOCK + 600, sourceGeneration: "consumer-source" },
        observedAtSec: CLOCK - 60 });
      expect(Object.fromEntries(packet.deployments.map(row => [row.deploymentKey, row.currentSupplyUsd]))).toEqual({
        [CANONICAL]: 160, [REMOTE]: 40,
      });
      const stored = generation.attributionById.alpha!;
      if (stored.model !== "reviewed-economic-deployment-partition-v1") throw new Error("Expected economic capture");
      expect(Object.fromEntries(packet.observations.map(row => [row.id, row])))
        .toEqual(Object.fromEntries(stored.observations.map(row => [row.id, row])));
    });
  });

  it.each(["base", "source", "clock", "aggregate"])("rejects a stale or forged capture %s binding", async binding => {
    await withEconomicHandoff(fixture(), ({ consumer, generation, apply }) => {
      const packet = generation.attributionById.alpha!;
      if (packet.model !== "reviewed-economic-deployment-partition-v1") throw new Error("Expected economic packet");
      if (binding === "base") packet.baseInputGenerationId = consumer.baseInputGenerationId;
      if (binding === "source") packet.sourceGeneration = consumer.sourceGeneration;
      if (binding === "clock") packet.scoringClockSec++;
      if (binding === "aggregate") packet.aggregate.sourceGeneration = consumer.sourceGeneration;
      expect(apply(consumer, generation)).toMatchObject({ status: "applied", acceptedAssetIds: [], invalidAssetIds: ["alpha"] });
    });
  });

  it("admits the capture clock, but never consumes a post-publication capture or stale raw state", async () => {
    const input = fixture(); input.clockSec = CLOCK + 300;
    input.observations.forEach(row => row.observedAtSec = CLOCK + 299);
    input.inFlight.forEach(row => row.observedAtSec = CLOCK + 299);
    await withEconomicHandoff(input, ({ consumer, generation, apply }) => {
      expect(apply(consumer, generation)).toMatchObject({ status: "applied", acceptedAssetIds: ["alpha"] });
      expect(apply({ ...consumer, clockSec: CLOCK + 299 }, generation)).toMatchObject({ status: "incompatible", reason: "capture-clock-after-consumer" });
      consumer.clockSec = CLOCK + 2100;
      consumer.aggregateCirculatingById.alpha!.observedAtSec = consumer.clockSec;
      consumer.navPriceById!.alpha!.observedAtSec = consumer.clockSec;
      expect(apply(consumer, generation)).toMatchObject({ status: "applied", acceptedAssetIds: [], invalidAssetIds: ["alpha"] });
    });
  });

  it("rebuilds input-derived provider quantities instead of stamping captured provider rows with a new generation", async () => {
    const input = independentFixture();
    input.plan.deployments.forEach(row => { row.read = { kind: "provider-chain", sourceChain: row.chainId }; row.amountBasis = "circulating-usd"; row.decimals = null; });
    input.observations = input.observations.slice(0, 2);
    input.meta.contracts!.forEach(contract => contract.decimals = null);
    input.observations[0]!.amount = "80"; input.observations[1]!.amount = "20";
    await withEconomicHandoff(input, ({ consumer, generation, apply }) => {
      consumer.aggregateCirculatingById.alpha!.circulating.peggedUSD = 210;
      const history = { circulatingPrevDay: 0, circulatingPrevWeek: 0, circulatingPrevMonth: 0 };
      consumer.chainCirculatingById.alpha = { ethereum: { ...history, current: 150 }, base: { ...history, current: 50 } };
      const result = apply(consumer, generation);
      expect(result).toMatchObject({ status: "applied", acceptedAssetIds: ["alpha"], invalidAssetIds: [] });
      expect(result.fixedInput.safetyScoreV9SupplyAttributionById.alpha).toMatchObject({
        deployments: expect.arrayContaining([expect.objectContaining({ deploymentKey: CANONICAL, currentSupplyUsd: 150 }),
          expect.objectContaining({ deploymentKey: REMOTE, currentSupplyUsd: 50 })]), unattributedSupplyUsd: 10,
        observations: expect.arrayContaining([expect.objectContaining({ deploymentKey: CANONICAL, amount: "150", anchor: "consumer-source", observedAtSec: CLOCK + 600 }),
          expect.objectContaining({ deploymentKey: REMOTE, amount: "50", anchor: "consumer-source", observedAtSec: CLOCK + 600 })]),
      });
    });
  });

  it("recomputes native aggregate-derived units from the actual consumer aggregate and reference price", async () => {
    const input = independentFixture(), nativeKey = "ethereum:native:ether";
    Object.assign(input.plan.deployments[0]!, { deploymentKey: nativeKey, holdingKind: "native-gas", amountBasis: "native-ledger",
      address: "ether", decimals: null, routeId: null, read: { kind: "native-from-aggregate", safeBlockLag: 2 } });
    input.meta.contracts!.shift(); input.meta.bridgeRouteRisk!.routes!.shift();
    input.observations = input.observations.slice(0, 2);
    Object.assign(input.observations[0]!, { id: nativeKey, deploymentKey: nativeKey, amount: "100", anchor: "attributed:source" });
    await withEconomicHandoff(input, ({ consumer, generation, apply }) => {
      consumer.aggregateCirculatingById.alpha!.circulating.peggedUSD = 300;
      consumer.clockSec = CLOCK + 60;
      consumer.aggregateCirculatingById.alpha!.observedAtSec = CLOCK + 60;
      consumer.navPriceById!.alpha!.observedAtSec = CLOCK + 60;
      const result = apply(consumer, generation);
      expect(result).toMatchObject({ status: "applied", acceptedAssetIds: ["alpha"], invalidAssetIds: [] });
      const packet = result.fixedInput.safetyScoreV9SupplyAttributionById.alpha!;
      if (packet.model !== "reviewed-economic-deployment-partition-v1") throw new Error("Expected economic packet");
      expect(packet.observations.find(row => row.id === nativeKey)).toMatchObject({
        amount: "150", anchor: "attributed:consumer-source", observedAtSec: CLOCK + 60,
      });
      expect(packet.deployments.find(row => row.deploymentKey === nativeKey)!.currentSupplyUsd).toBeCloseTo(300 * 150 / 170);
    });
  });
});

describe("reviewed same-chain provider partition", () => {
  const chainClock = 1791184659;
  const assetId = "usdc-circle";
  function chainFixture() {
    const review = structuredClone(REVIEWED_PROVIDER_CHAIN_PARTITIONS.get(assetId)!);
    const meta = structuredClone(ACTIVE_META_BY_ID.get(assetId)!);
    const fixedInput = makeV9FixedInput({ assetId, clockSec: chainClock });
    const history = { circulatingPrevDay: 0, circulatingPrevWeek: 0, circulatingPrevMonth: 0 };
    fixedInput.chainCirculatingById = { [assetId]: { "X Layer": { ...history, current: 100 }, Ethereum: { ...history, current: 900 } } };
    fixedInput.aggregateCirculatingById = { [assetId]: { circulating: { peggedUSD: 1000 }, observedAtSec: chainClock - 60 } };
    const observations: SafetyScoreV9TransferMaterialityObservation[] = review.deployments.map((row, index) => ({
      deploymentKey: row.routeId, rawTokenUnits: index === 0 ? "20000000" : "80000000",
      decimals: row.decimals, blockNumber: "100", blockHash: `0x${"a".repeat(64)}`,
      observedAtSec: chainClock - 60, status: "accepted",
    }));
    const derive = () => deriveReviewedProviderChainPartition({ review, meta, clockSec: fixedInput.clockSec, supplyUsd: 100, observations });
    const generation = () => createSafetyScoreV9TransferMaterialityGeneration({
      schemaVersion: 1, kind: "safety-score-v9-transfer-materiality-generation",
      sourceBaseInputGenerationId: fixedInput.baseInputGenerationId,
      registryFingerprint: fixedInput.registryFingerprint, capturedAtSec: chainClock,
      observationsByAssetId: { [assetId]: observations },
    });
    return { review, meta, fixedInput, observations, derive, generation };
  }

  it("conserves only the exact mixed chain row and preserves native/bridged control attribution", () => {
    const input = chainFixture();
    const review = buildSafetyScoreV9SupplyReview(input.fixedInput, assetId, input.meta.bridgeRouteRisk, {
      meta: input.meta, transferMaterialityGeneration: input.generation(),
    })!;
    expect(review.selectedBridgeRoutes.filter(row => row.deploymentRouteKey.startsWith("xlayer:"))).toEqual([
      { deploymentRouteKey: input.review.deployments[0]!.routeId, supplyUsd: 20, supplyShare: 0.02, reviewState: "selected-reviewed", reviewedRouteKind: "controlled" },
      { deploymentRouteKey: input.review.deployments[1]!.routeId, supplyUsd: 80, supplyShare: 0.08, reviewState: "selected-reviewed", reviewedRouteKind: "native" },
    ]);
    expect(review.selectedBridgeRoutes.find(row => row.deploymentRouteKey.startsWith("ethereum:"))?.supplyUsd).toBe(900);
    expect(review.selectedBridgeRoutes.reduce((sum, row) => sum + row.supplyUsd!, 0)).toBe(1000);
    expect(exactInputBoundTransferMaterialityPacket({
      assetId, meta: input.meta, generation: input.generation(), registryFingerprint: input.fixedInput.registryFingerprint,
      baseInputGenerationId: input.fixedInput.baseInputGenerationId, clockSec: chainClock,
    })).toBeNull();
  });

  it.each(["missing", "duplicate", "rejected", "decimals", "number", "hash", "time", "stale", "future", "expanded", "unreviewed", "expired"] as const)(
    "retains ambiguity for a %s chain census", failure => {
      const input = chainFixture();
      const row = input.observations[1]!;
      if (failure === "missing") input.observations.pop();
      if (failure === "duplicate") input.observations[1] = { ...input.observations[0]! };
      if (failure === "rejected") Object.assign(row, { status: "rejected", rawTokenUnits: null, decimals: null, blockNumber: null, observedAtSec: null });
      if (failure === "decimals") row.decimals = 18;
      if (failure === "number") row.blockNumber = "101";
      if (failure === "hash") row.blockHash = `0x${"b".repeat(64)}`;
      if (failure === "time") row.observedAtSec!--;
      if (failure === "stale") input.observations.forEach(value => value.observedAtSec = chainClock - 1801);
      if (failure === "future") input.observations.forEach(value => value.observedAtSec = chainClock + 1);
      if (failure === "expanded") input.meta.contracts!.push({ chain: "xlayer", address: `0x${"f".repeat(40)}`, decimals: 6 });
      if (failure === "unreviewed") input.meta.bridgeRouteRisk!.routes!.find(route => route.id === input.review.deployments[1]!.routeId)!.reviewDisposition = "unresolved";
      if (failure === "expired") input.review.expiresAtSec = chainClock;
      expect(input.derive()).toBeNull();
    },
  );

  it.each([1800, 1801])("honors the exact %s-second observation boundary", age => {
    const input = chainFixture();
    input.observations.forEach(row => row.observedAtSec = chainClock - age);
    expect(input.derive() === null).toBe(age > 1800);
  });

  it("distinguishes an authentic zero from missing supply and preserves tiny nonzero units", () => {
    const input = chainFixture();
    input.observations[0]!.rawTokenUnits = "0";
    expect(input.derive()?.map(row => row.supplyUsd)).toEqual([0, 100]);
    input.observations[0]!.rawTokenUnits = "1";
    expect(input.derive()![0]!.supplyUsd).toBeGreaterThan(0);
    input.observations.forEach(row => row.rawTokenUnits = "0");
    expect(input.derive()).toBeNull();
    expect(deriveReviewedProviderChainPartition({ review: input.review, meta: input.meta, clockSec: chainClock, supplyUsd: 0, observations: input.observations })?.map(row => row.supplyUsd)).toEqual([0, 0]);
  });

  it.each(["base", "registry", "stale", "future"] as const)("does not join a %s generation", mismatch => {
    const input = chainFixture(), generation = input.generation();
    if (mismatch === "base") generation.sourceBaseInputGenerationId = `report-cards-input:v1:${"e".repeat(64)}`;
    if (mismatch === "registry") generation.registryFingerprint = "f".repeat(64);
    if (mismatch === "stale") generation.capturedAtSec = chainClock - 1801;
    if (mismatch === "future") generation.capturedAtSec = chainClock + 1;
    const review = buildSafetyScoreV9SupplyReview(input.fixedInput, assetId, input.meta.bridgeRouteRisk, { meta: input.meta, transferMaterialityGeneration: generation })!;
    expect(review.selectedBridgeRoutes.find(row => row.deploymentRouteKey === `ambiguous-chain:${assetId}:xlayer`))
      .toMatchObject({ supplyUsd: 100, supplyShare: 0.1, reviewState: "unmatched" });
  });

  it("bounds local censuses at eight deployments without enlarging the whole-asset economic plan", () => {
    const input = chainFixture();
    input.review.deployments = Array.from({ length: 8 }, (_, index) => {
      const address = `0x${(index + 1).toString(16).padStart(40, "0")}`;
      return { address, routeId: `xlayer:${address}`, decimals: 6 };
    });
    expect(ReviewedProviderChainPartitionSchema.safeParse(input.review).success).toBe(true);
    input.review.deployments.push({ address: `0x${"f".repeat(40)}`, routeId: `xlayer:0x${"f".repeat(40)}`, decimals: 6 });
    expect(ReviewedProviderChainPartitionSchema.safeParse(input.review).success).toBe(false);
    const whole = fixture().plan;
    whole.accountingFamily = "independent-liability";
    whole.escrows = [];
    whole.deployments = Array.from({ length: 88 }, (_, index) => {
      const address = `0x${(index + 1).toString(16).padStart(40, "0")}`;
      return { ...whole.deployments[0]!, address, deploymentKey: `ethereum:${address}` };
    });
    expect(ReviewedEconomicSupplyPlanSchema.safeParse(whole).success).toBe(false);
    whole.deployments = whole.deployments.slice(0, 65);
    expect(ReviewedEconomicSupplyPlanSchema.safeParse(whole).success).toBe(false);
    whole.deployments.pop();
    expect(ReviewedEconomicSupplyPlanSchema.safeParse(whole).success).toBe(true);
  });
});

describe("reviewed XGLD, srUSD and wiTRY OFT supply plans", () => {
  function cohortFixture(assetId: "xgld-unitas" | "srusd-reservoir" | "witry-brix"): EconomicFixture {
    const plan = structuredClone(REVIEWED_ECONOMIC_SUPPLY_PLANS.get(assetId)!);
    const meta = ACTIVE_META_BY_ID.get(assetId)!;
    const clockSec = plan.reviewedAtSec + 60;
    const source = plan.liabilityInFlightSource ?? plan.escrows[0]!.inFlightSource!;
    if (!("kind" in source) || source.kind !== "evm-layerzero-oft-pending") throw new Error("Expected reviewed OFT pending source");
    const observations = plan.deployments.map((row, index): EconomicSupplyObservation => ({
      id: row.deploymentKey, deploymentKey: row.deploymentKey,
      amount: ((index === 0 ? 100n : index === 1 ? 20n : 0n) * 10n ** BigInt(row.decimals!)).toString(),
      observedAtSec: clockSec - 60, anchor: String(source.sides[index]!.deploymentBlock + 100),
      anchorHash: `0x${String(index + 1).repeat(64)}`, responseSha256: "b".repeat(64),
    }));
    if (assetId === "xgld-unitas") observations[3]!.amount = "1";
    const canonical = observations[0]!;
    for (const escrow of plan.escrows) observations.push({ ...canonical, id: escrow.id, amount: observations[1]!.amount });
    const proof: NonNullable<EconomicSupplyObservation["layerZeroOftPendingProof"]> = {
      sourceDigest: sha256Hex(stableJsonStringifyV1(source)), checkpointDigest: "f".repeat(64),
      pins: source.sides.map((side, index) => ({
        chainId: side.chainId, eid: side.eid, anchor: Number(observations[index]!.anchor),
        anchorHash: observations[index]!.anchorHash, observedAtSec: observations[index]!.observedAtSec,
      })),
      pathways: source.pathways.map(path => ({
        ...path, sentNonce: "0", inboundNonce: "0", lazyInboundNonce: "0", pendingCount: 0, pendingAmountSD: "0",
      })),
    };
    const pending: EconomicSupplyObservation = {
      ...canonical, id: plan.liabilityInFlightSource ? "in-flight:liability" : `in-flight:${plan.escrows[0]!.id}`,
      amount: "0", layerZeroOftPendingProof: proof,
      responseSha256: sha256Hex(stableJsonStringifyV1({ proof, amount: "0" })),
    };
    return {
      plan, meta, clockSec, baseInputGenerationId: `report-cards-input:v1:${"c".repeat(64)}`,
      sourceGeneration: "live-aggregate", registryFingerprint: "d".repeat(64),
      aggregate: { supplyUsd: 100, sourceGeneration: "live-aggregate", observedAtSec: clockSec - 60 },
      referencePrice: { sourceId: plan.sourceId, sourceGeneration: "independent-price", observedAtSec: clockSec - 60, value: "4000", responseSha256: "e".repeat(64) },
      conversions: [], observations, inFlight: [pending],
    };
  }

  it("rejects the issuer's two-chain XGLD subset despite an otherwise valid pending schema", () => {
    const input = cohortFixture("xgld-unitas");
    const source = input.plan.liabilityInFlightSource!;
    if (!("kind" in source) || source.kind !== "evm-layerzero-oft-pending") throw new Error("Expected OFT");
    input.plan.deployments = input.plan.deployments.slice(0, 2);
    source.sides = source.sides.slice(0, 2);
    source.pathways = source.pathways.filter(path => path.sourceIndex < 2 && path.destinationIndex < 2);
    expect(ReviewedEconomicSupplyPlanSchema.safeParse(input.plan).success).toBe(true);
    expect(buildReviewedEconomicDeploymentInventory(input.plan.assetId, input.plan, input.meta)).toBeNull();
  });

  it("retains XGLD's measured Ethereum zero and Mantle dust without treating missing pending as zero", () => {
    const input = cohortFixture("xgld-unitas");
    const packet = deriveReviewedEconomicDeploymentPartition(input)!;
    expect(packet.aggregate.supplyUsd).toBe(100);
    expect(packet.deployments[2]!.currentSupplyUsd).toBe(0);
    expect(packet.deployments[3]!.currentSupplyUsd).toBeGreaterThan(0);
    expect(packet.deployments.reduce((sum, row) => sum + row.currentSupplyUsd, 0)).toBeCloseTo(100);
    input.inFlight = [];
    expect(deriveReviewedEconomicDeploymentPartition(input)).toBeNull();
  });

  it.each(["missing holding", "different holding pin", "missing pathway", "different price source"] as const)(
    "rejects XGLD's %s rather than granting control materiality", failure => {
      const input = cohortFixture("xgld-unitas");
      if (failure === "missing holding") input.observations.pop();
      if (failure === "different holding pin") input.observations[3]!.anchorHash = `0x${"a".repeat(64)}`;
      if (failure === "missing pathway") input.inFlight[0]!.layerZeroOftPendingProof!.pathways.pop();
      if (failure === "different price source") input.referencePrice.sourceId = "gold-par";
      expect(deriveReviewedEconomicDeploymentPartition(input)).toBeNull();
    },
  );

  it("subtracts srUSD backing once and retains authenticated in-flight shares as unattributed", () => {
    const input = cohortFixture("srusd-reservoir");
    const pending = input.inFlight[0]!, proof = pending.layerZeroOftPendingProof!;
    Object.assign(proof.pathways[0]!, { sentNonce: "1", pendingCount: 1, pendingAmountSD: "1000000" });
    pending.amount = "1000000000000000000";
    pending.responseSha256 = sha256Hex(stableJsonStringifyV1({ proof, amount: pending.amount }));
    input.observations[2]!.amount = "21000000000000000000";
    const packet = deriveReviewedEconomicDeploymentPartition(input)!;
    expect(packet.deployments.map(row => row.currentSupplyUsd)).toEqual([79, 20]);
    expect(packet.unattributedSupplyUsd).toBe(1);
    input.observations[2]!.amount = "20000000000000000000";
    expect(deriveReviewedEconomicDeploymentPartition(input)).toBeNull();
  });

  it("rejects a srUSD receipt or escrow balance from a different same-chain state", () => {
    const input = cohortFixture("srusd-reservoir");
    expect(deriveReviewedEconomicDeploymentPartition(input)!.deployments.map(row => row.currentSupplyUsd)).toEqual([80, 20]);
    input.observations[2]!.anchor = String(Number(input.observations[2]!.anchor) - 1);
    expect(deriveReviewedEconomicDeploymentPartition(input)).toBeNull();
  });

  it("joins both wiTRY spokes to one canonical escrow and rejects an omitted Robinhood share holding", () => {
    const input = cohortFixture("witry-brix");
    input.observations[2]!.amount = "10000000000000000000";
    input.observations[3]!.amount = "30000000000000000000";
    const packet = deriveReviewedEconomicDeploymentPartition(input)!;
    expect(packet.deployments.map(row => row.currentSupplyUsd)).toEqual([70, 20, 10]);
    expect(packet.unattributedSupplyUsd).toBe(0);
    input.observations.splice(2, 1);
    expect(deriveReviewedEconomicDeploymentPartition(input)).toBeNull();
  });
});
