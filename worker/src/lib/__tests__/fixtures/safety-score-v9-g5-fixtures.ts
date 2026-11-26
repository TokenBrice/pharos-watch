import { ACTIVE_META_BY_ID, ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import { DEX_ROUTE_CAPABILITY_MATRIX_VERSION } from "@shared/lib/p4-exit-route-capability-policy";
import { getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import { PegSummaryCoinSchema, type DepegEvent, type PegSummaryCoin } from "@shared/types/peg";
import { assessReserveFetchFreshness } from "../../live-reserves/store-snapshot-state";
import { makeRedemptionWriteRecord } from "../redemption-backstops-store.test-support";
import { inheritPureWrapperPegObservations } from "../../safety-score-v9/capture";

export const V9_CAPTURE_TEST_RUN = 1790000000;
export const CHILD = "usdn-noble", PARENT = "m-m0";
export type TestMeta = Pick<StablecoinMeta, "variantOf" | "variantKind" | "pegReferenceId" | "flags">;
export const OBSERVED_REFERENCE = { valueUsd: 1, source: "median" as const, contributorCount: 294, asOf: 1_793_294_137 };

export function makeV9CaptureFixtureSources(scoringClock: number, fetchedAt = V9_CAPTURE_TEST_RUN - 48 * 3600 + 60, metadataValid = true, runAt = V9_CAPTURE_TEST_RUN) {
  const entry = { ...makeRedemptionWriteRecord(), stablecoinId: "iusd-infinifi", updatedAt: runAt };
  const reserveInput = {
    generationId: "reserve:1790000000:test", contentSha256: "a".repeat(64), stablecoinId: entry.stablecoinId, attemptId: "success",
    configFingerprint: computeLiveReserveConfigFingerprint(ACTIVE_META_BY_ID.get(entry.stablecoinId)!.liveReservesConfig!),
    freshness: assessReserveFetchFreshness({ fetchedAt, attemptId: "success", metadata: { freshnessMode: "not-applicable" } }, runAt, 172800),
  };
  const runMetadata = metadataValid
    ? { reserveViewSchemaVersion: 2, reserveGenerationId: reserveInput.generationId, reserveContentSha256: reserveInput.contentSha256, runClockSec: runAt, consumedReserveInputs: { [entry.stablecoinId]: reserveInput } }
    : {};
  return {
    inputs: {
      stablecoinsCached: { kind: "ok", updatedAt: runAt, payload: { peggedAssets: [] } },
      dexLiquiditySnapshot: { latestUpdatedAt: runAt, map: Object.fromEntries(ACTIVE_STABLECOINS.map((c) => [c.id, { methodologyVersion: "1.0" }])) },
      redemptionBackstopMap: { [entry.stablecoinId]: { ...entry, reserveInput } },
      redemptionSnapshotProvenance: { runId: "redemption:actual", latestUpdatedAt: runAt, methodologyVersion: entry.methodologyVersion, runMetadata },
      liveReserveMap: new Map(), liveReserveProvenanceMap: new Map(), liquidityStale: false, redemptionStale: false,
      inputFreshness: { dexLiquidity: { updatedAt: runAt, ageSeconds: 0, stale: false }, redemptionBackstops: { updatedAt: runAt, ageSeconds: 0, stale: false } },
      v9PublicationInputHealth: { dex: { state: "current" }, redemption: { state: "current", generationId: "redemption:actual", updatedAtSec: runAt }, liveReserves: { state: "available", coverageRatio: 1 } },
    },
    peg: { nowSec: scoringClock, pegDataById: new Map(), eventsByCoin: new Map() },
  };
}

export function pegRow(overrides: Partial<PegSummaryCoin> = {}): PegSummaryCoin {
  return PegSummaryCoinSchema.parse({
    id: CHILD, symbol: "USDN", name: "Noble Dollar", pegType: "peggedUSD", pegCurrency: "USD", governance: "centralized",
    currentDeviationBps: null, currentPriceUnavailable: true, priceSource: "protocol-par", priceObservedAtMode: "nominal_reference",
    nominalPriceReference: { price: 1, source: "protocol-par", mode: "nominal_reference" },
    pegScore: 100, pegPct: 99.99, severityScore: 99.9, spreadPenalty: 0, eventCount: 2, worstDeviationBps: -189,
    activeDepeg: false, lastEventAt: 1_774_651_713, trackingSpanDays: 603, methodologyVersion: "10.36", ...overrides,
  });
}

export function wrapperMeta(overrides: Partial<TestMeta> = {}): TestMeta {
  return {
    variantOf: PARENT, variantKind: "pure-wrapper", pegReferenceId: PARENT,
    flags: { backing: "rwa-backed", pegCurrency: "USD", governance: "centralized", yieldBearing: false, rwa: true, navToken: false },
    ...overrides,
  };
}

export function observedParent(overrides: Partial<PegSummaryCoin> = {}): PegSummaryCoin {
  return pegRow({
    id: PARENT, symbol: "M", currentDeviationBps: -5, currentPriceUnavailable: undefined, priceSource: "coingecko",
    priceObservedAt: 1_774_651_720, priceObservedAtMode: "upstream", nominalPriceReference: undefined,
    pegReference: OBSERVED_REFERENCE, eventCount: 1, ...overrides,
  });
}

export function runInheritance(rows: PegSummaryCoin[], meta: Record<string, TestMeta> = { [CHILD]: wrapperMeta() }) {
  return inheritPureWrapperPegObservations(new Map(rows.map((e) => [e.id, e])), new Map(Object.entries(meta)));
}

export const G5_ANCHOR_ID = "gusd-gemini";
// DEX-only active coin (no redemption backstop) so DEX quarantine yields genuine excluded-a-b exit unavailability.
export const G5_R1_QUARANTINED_DEX_ID = "mai-qidao";
export const G5_R2_ERRATUM_ID = "reusd-resupply";
export const G5_R3_DUST_SUSPENDED_ID =
  ACTIVE_STABLECOINS.find((c) => !c.flags.navToken && getRedemptionBackstopConfig(c.id)?.routeSuspension)?.id ?? "vnxau-vnx";
export const G5_R4_FOREIGN_PROVIDER_ID = "apyusd-apyx";
export const G5_SUBSET_IDS = [G5_ANCHOR_ID, G5_R1_QUARANTINED_DEX_ID, G5_R2_ERRATUM_ID, G5_R3_DUST_SUSPENDED_ID, G5_R4_FOREIGN_PROVIDER_ID].sort();

export function makeG5CaptureSources(clockSec: number, dexAt: number) {
  const dexRow = (id: string, dust: boolean) => {
    const ex = (n: number) => (dust ? 999.9 : n * 0.8);
    return {
      methodologyVersion: "1.0",
      exitRouteObservations: [{
        routeId: `dex:g5:${id}`, routeFamily: "dex-amm" as const,
        scope: { kind: "chain-contract" as const, chain: "ethereum", contractOrPoolId: `${id}:p`, protocol: "g5-dex" },
        requestedNotionalUsd: 100_000, settlementHorizonSec: 300, maxCostBps: 200,
        executableUsd: ex(100_000), completionRatio: ex(100_000) / 100_000,
        output: { kind: "fiat" as const, currency: "USD", assetKeys: ["fiat:USD"] },
        evidenceKind: "reserve-based-amm-simulation" as const, confidence: "high" as const, scoreEligible: true,
        observedAt: dexAt, freshnessSeconds: 60, commonModeKeys: ["chain:ethereum", "protocol:g5-dex"],
        capacityCurve: [1e5, 1e6, 1e7, 1e8].map((n) => ({ requestedNotionalUsd: n, maxCostBps: 200, executableUsd: ex(n), completionRatio: ex(n) / n })),
      }],
      exitRouteObservationCoverage: {
        status: "populated" as const, capabilityMatrixVersion: DEX_ROUTE_CAPABILITY_MATRIX_VERSION,
        retainedPoolCount: 1, observationCount: 1, scoreEligibleObservationCount: 1, scoreEligiblePoolCount: 1,
        scoreEligibleCapabilityPoolCount: 1, unsupportedPoolCount: 0,
        evidenceCounts: { "reserve-based-amm-simulation": 1 }, unsupportedReasons: {},
      },
    };
  };
  const makePeg = (id: string, eventCount: number) => {
    const m = ACTIVE_META_BY_ID.get(id)!;
    return pegRow({
      id, symbol: m.symbol, name: m.name, pegType: `pegged${m.flags.pegCurrency}`, pegCurrency: m.flags.pegCurrency, governance: m.flags.governance,
      currentDeviationBps: 1, currentPriceUnavailable: undefined, nominalPriceReference: undefined, priceSource: "coingecko",
      priceObservedAt: dexAt, priceObservedAtMode: "upstream", pegReference: { valueUsd: 1, source: "median", contributorCount: 10, asOf: dexAt },
      pegScore: 100, pegPct: 100, severityScore: 100, spreadPenalty: 0, eventCount, worstDeviationBps: null, activeDepeg: false,
      lastEventAt: null, trackingSpanDays: 365, historyCoverage: { startedAt: clockSec - 365 * 86_400, source: "asset-age", status: "assumed" },
    });
  };
  const erratum: DepegEvent = {
    id: 90775, stablecoinId: G5_R2_ERRATUM_ID, symbol: ACTIVE_META_BY_ID.get(G5_R2_ERRATUM_ID)!.symbol,
    pegType: "peggedUSD", direction: "below", peakDeviationBps: -900,
    startedAt: clockSec - 10 * 86_400, endedAt: clockSec - 9 * 86_400,
    startPrice: 0.99, peakPrice: 0.91, recoveryPrice: 1, pegReference: 1, source: "live",
    confirmationSources: null, pendingReason: null, closeReason: null,
    // Production public_json for clockless verdict-only disputed errata (dc64db48b).
    provenance: JSON.parse('{"auditVerdict":"disputed"}') as NonNullable<DepegEvent["provenance"]>,
  };
  return {
    inputs: {
      stablecoinsCached: {
        kind: "ok", updatedAt: dexAt,
        payload: { peggedAssets: G5_SUBSET_IDS.map((id) => ({ id, circulating: { peggedUSD: 1e7 }, supplyObservedAt: dexAt, chainCirculating: { ethereum: { current: 1e7 } } })) },
      },
      dexLiquiditySnapshot: {
        latestUpdatedAt: dexAt,
        map: Object.fromEntries(ACTIVE_STABLECOINS.filter((c) => c.id !== G5_R1_QUARANTINED_DEX_ID)
          .map((c) => [c.id, G5_SUBSET_IDS.includes(c.id) ? dexRow(c.id, c.id === G5_R3_DUST_SUSPENDED_ID) : { methodologyVersion: "1.0" }])),
        quarantined: { [G5_R1_QUARANTINED_DEX_ID]: { reason: "invalid-coverage-evidence", methodologyVersion: "1.0" } },
      },
      redemptionBackstopMap: {},
      redemptionSnapshotProvenance: { runId: "redemption:g5", latestUpdatedAt: dexAt, methodologyVersion: "1.0", runMetadata: {} },
      liveReserveMap: new Map(G5_SUBSET_IDS.map((id) => [id, [{ name: "Cash", pct: 100, risk: "very-low", assetClass: "cash", issuerOrObligor: `issuer:${id}`, riskFactors: ["custody"], liquidityHorizon: "immediate", maturityDaysMax: 0 }]])),
      liveReserveProvenanceMap: new Map(G5_SUBSET_IDS.map((id) => [id, { source: "g5", fetchedAt: dexAt }])),
      liquidityStale: false, redemptionStale: true,
      inputFreshness: { dexLiquidity: { updatedAt: dexAt, ageSeconds: 60, stale: false }, redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true } },
      v9PublicationInputHealth: { dex: { state: "current" }, redemption: { state: "stale", generationId: "redemption:g5", updatedAtSec: dexAt }, liveReserves: { state: "available", coverageRatio: 1 } },
    },
    peg: {
      nowSec: clockSec,
      pegDataById: new Map(G5_SUBSET_IDS.map((id) => [id, makePeg(id, id === G5_R2_ERRATUM_ID ? 1 : 0)])),
      eventsByCoin: new Map([[G5_R2_ERRATUM_ID, [erratum]]]),
    },
  };
}
