import { describe, expect, it } from "vitest";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import type { MintAuthorityCoverageSummary } from "@shared/types/stablecoin-client-meta";
import type { CoverageFeatureDefinition, CoverageFeatureKey } from "@/lib/coverage-types";
import { buildCoverageFeatureSummary, buildCoverageRow, COVERAGE_FEATURES } from "@/lib/coverage";
import { coverageFeature as blacklistCoverageFeature } from "@/lib/coverage/blacklist";
import { coverageFeature as dependencyCoverageFeature } from "@/lib/coverage/dependency";
import { coverageFeature as dexCoverageFeature } from "@/lib/coverage/dex";
import { coverageFeature as flowCoverageFeature } from "@/lib/coverage/flows";
import { coverageFeature as geniusCoverageFeature } from "@/lib/coverage/genius";
import { coverageFeature as mintAuthorityCoverageFeature } from "@/lib/coverage/mint-authority";
import { coverageFeature as micaCoverageFeature } from "@/lib/coverage/mica";
import { coverageFeature as priceCoverageFeature } from "@/lib/coverage/price";
import { coverageFeature as redemptionCoverageFeature } from "@/lib/coverage/redemption";
import { coverageFeature as reserveCoverageFeature } from "@/lib/coverage/reserves";
import { coverageFeature as safetyCoverageFeature } from "@/lib/coverage/safety";
import { matchesCoverageFilter } from "@/lib/coverage-filtering";
import { makeStablecoinMeta } from "@shared/test-utils/stablecoin";

type TestCoin = StablecoinMeta & { mintAuthoritySummary?: MintAuthorityCoverageSummary };
const makeFlags = (partial: Partial<StablecoinMeta["flags"]> = {}): StablecoinMeta["flags"] => ({ ...makeStablecoinMeta().flags, rwa: true, ...partial });
const makeCoin = (overrides?: Partial<TestCoin>): TestCoin =>
  makeStablecoinMeta({ id: "test-usd", name: "Test USD", symbol: "TUSDX", flags: makeFlags(), ...overrides });
const makeNavCoin = (yieldBearing = false): TestCoin =>
  makeCoin({ flags: makeFlags({ backing: "rwa-backed", governance: "centralized", pegCurrency: "USD", yieldBearing, navToken: true }) });

function makeRedemptionEntry(overrides?: Partial<RedemptionBackstopEntry>): RedemptionBackstopEntry {
  return {
    stablecoinId: "test-usd", score: 72, dexLiquidityScore: 58, accessScore: 100, settlementScore: 100,
    executionCertaintyScore: 100, capacityScore: 60, outputAssetQualityScore: 100, costScore: 40,
    routeFamily: "psm-swap", accessModel: "permissionless-onchain", settlementModel: "atomic",
    executionModel: "deterministic-onchain", outputAssetType: "stable-single", provider: "supply-ratio-model",
    sourceMode: "estimated", resolutionState: "resolved", routeStatus: "open", routeStatusSource: "static-config",
    holderEligibility: "any-holder", capacityConfidence: "documented-bound", capacitySemantics: "immediate-bounded",
    feeConfidence: "undisclosed-reviewed", feeModelKind: "undisclosed-reviewed", modelConfidence: "medium",
    immediateCapacityUsd: 10_000_000, immediateCapacityRatio: 0.15, feeBps: null, queueEnabled: false,
    methodologyVersion: "1.1", updatedAt: 1_700_000_000, ...overrides,
  };
}

const LIVE_RESERVE_CONFIGS = {
  live: { adapter: "infinifi", version: 1, semantics: "collateral-mix", inputs: { primary: { kind: "http-json", url: "https://example.com/reserves" } } },
  curatedValidated: { adapter: "curated-validated", version: 1, semantics: "attestation-mix", inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } } },
  proof: { adapter: "single-asset", version: 1, semantics: "single-asset", inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } }, params: { label: "Issuer reserves", risk: "very-low" } },
} satisfies Record<string, NonNullable<StablecoinMeta["liveReservesConfig"]>>;

const CURATED_RESERVES: StablecoinMeta["reserves"] = [{ name: "Cash", pct: 100, risk: "very-low" }];

function makeCoverageRow([id, symbol]: readonly [string, string], overrides: Partial<Parameters<typeof buildCoverageRow>[0]> = {}) {
  const { coin, ...rest } = overrides;
  return buildCoverageRow({
    coin: { ...(coin ?? makeCoin()), id, symbol }, marketCapUsd: 100, hasPegCoverage: true,
    safetyScore: 82, safetyRatingStatus: "rated", dexCoverageClass: "primary", redemptionEntry: null,
    hasYieldCoverage: false, flowCoverageStatus: null,
    dependencyCoverage: { kind: "unmapped-gap", upstreamCount: 0, dependentCount: 0 }, ...rest,
  });
}

const coverageFeature = (key: CoverageFeatureKey) => COVERAGE_FEATURES.find((f) => f.key === key)!;

describe("coverage helpers", () => {
  it.each([
    ["genius", ["ppsi-approved", "state-qualified", "official-application-pending", "issuer-announced-intent", "no-public-authorization-found", "not-applicable", "unknown", "unassessed"]],
    ["mica", ["authorized", "pending", "transitional", "non-compliant", "out-of-scope", "unassessed"]],
    ["blacklist", ["live", "yes", "upstream", "possible", "no"]],
    ["safety", ["rated", "data-unavailable"]],
    ["yield", ["ranked"]],
  ] as const)("preserves the %s legend order and non-empty terms/descriptions", (key, expectedKinds) => {
    const items = coverageFeature(key).legendItems;
    expect(items.flatMap((item) => item.kinds)).toEqual([...expectedKinds]);
    for (const item of items) {
      expect(item.term.trim().length).toBeGreaterThan(0);
      expect(item.description.trim().length).toBeGreaterThan(0);
    }
  });

  it("keeps rated zero, genuine NR, and technical safety gaps in disjoint populations", () => {
    expect(safetyCoverageFeature.resolve(0, "rated")).toMatchObject({ kind: "rated", available: true });
    expect(safetyCoverageFeature.resolve(null, "not-rated")).toMatchObject({ kind: "nr", spokenLabel: "Not rated" });
    expect(safetyCoverageFeature.resolve(80, undefined).kind).toBe("data-unavailable");
    const gap = makeCoverageRow(["gap", "GAP"], { safetyScore: null, safetyRatingStatus: "pipeline-gap", safetyReasonCodes: ["single-pillar-pipeline-gap"], marketCapUsd: 700 });
    const nr = makeCoverageRow(["nr", "NR"], { safetyScore: null, safetyRatingStatus: "not-rated", marketCapUsd: 100 });
    const rated = makeCoverageRow(["zero", "ZERO"], { safetyScore: 0, marketCapUsd: 200 });
    expect(gap.statuses.safety).toMatchObject({ kind: "data-unavailable", label: "Data n/a", available: false });
    expect(gap.statuses.safety.detail).toContain("single-pillar-pipeline-gap");
    expect(gap.statuses.safety.spokenLabel).not.toMatch(/NR|Not rated/);
    expect(matchesCoverageFilter(gap, "missing-safety")).toBe(false);
    expect(matchesCoverageFilter(nr, "missing-safety")).toBe(true);
    const summary = buildCoverageFeatureSummary(coverageFeature("safety"), [rated, nr, gap]);
    expect(summary).toMatchObject({ availableCount: 1, totalCount: 2, coveragePct: 50, mcapSharePct: 200 / 300 * 100 });
    expect(summary.breakdown).toEqual([
      { key: "rated", label: "rated", count: 1 }, { key: "nr", label: "NR", count: 1 }, { key: "data-unavailable", label: "data n/a", count: 1 },
    ]);
  });

  it("keeps market-cap reach unavailable when only uncovered rows have observed cap", () => {
    const summary = buildCoverageFeatureSummary(coverageFeature("yield"), [
      makeCoverageRow(["covered", "COV"], { hasYieldCoverage: true, marketCapAvailable: false }),
      makeCoverageRow(["uncovered", "UNC"], { hasYieldCoverage: false, marketCapUsd: 100 }),
    ]);
    expect(summary).toMatchObject({ coveredMcapUsd: null, mcapSharePct: null, marketCapObservedCount: 1 });
  });

  it("handles NAV price-only, explicit current-price unavailability, and tracked source depths", () => {
    expect(priceCoverageFeature.resolve(makeNavCoin(true), false)).toMatchObject({ kind: "price-only", available: true });
    for (const coin of [makeCoin(), makeNavCoin(true)]) {
      const missing = priceCoverageFeature.resolve(coin, true, ["coingecko", "defillama", "pyth"], "high", true);
      expect(missing).toMatchObject({ kind: "missing", label: "Missing", available: false, detail: "No observed market price is available for this asset." });
      expect(missing.sourceCount).toBeUndefined();
    }
    const row = makeCoverageRow(["unpriced", "UNP"], { consensusSources: ["coingecko", "defillama", "pyth"], currentPriceUnavailable: true });
    expect(row.statuses.price).toMatchObject({ kind: "missing", available: false });
    expect(row.statuses.price.sourceCount).toBeUndefined();
    expect(priceCoverageFeature.legendItems.find((i) => i.kinds.includes("missing"))?.description).toBe("No observed market price is currently available for this asset.");

    expect(priceCoverageFeature.resolve(makeCoin(), true, ["coingecko", "defillama", "pyth"], "high"))
      .toMatchObject({ kind: "tracked", sourceCount: 3, sourceNames: ["coingecko", "defillama", "pyth"], priceConfidence: "high" });
    expect(priceCoverageFeature.resolve(makeCoin(), true, [], "single-source"))
      .toMatchObject({ kind: "tracked", sourceCount: 0, sourceNames: [], priceConfidence: "single-source" });
  });

  it("maps DEX coverage classes and keeps missing classes out of denominators", () => {
    expect(dexCoverageFeature.resolve("primary").label).toBe("Primary");
    expect(dexCoverageFeature.resolve("fallback").label).toBe("Fallback");
    expect(dexCoverageFeature.resolve("unobserved").available).toBe(false);
    expect(dexCoverageFeature.resolve(null)).toMatchObject({ kind: "data-unavailable", available: false });

    const summary = buildCoverageFeatureSummary(coverageFeature("dex"), [
      makeCoverageRow(["unobserved", "UNOBS"], { dexCoverageClass: "unobserved" }),
      makeCoverageRow(["missing", "MISS"], { dexCoverageClass: null }),
    ]);
    expect(summary).toMatchObject({ availableCount: 0, totalCount: 1, coveragePct: 0 });
    expect(summary.breakdown).toContainEqual({ key: "data-unavailable", label: "data n/a", count: 1 });

    const legacySummary = buildCoverageFeatureSummary(coverageFeature("dex"), [
      makeCoverageRow(["legacy", "LEG"], { dexCoverageClass: "legacy" }),
      makeCoverageRow(["unobserved", "UNOBS"], { dexCoverageClass: "unobserved" }),
    ]);
    expect(legacySummary).toMatchObject({ availableCount: 1, totalCount: 2 });
    expect(legacySummary.breakdown).toContainEqual({ key: "legacy", label: "legacy", count: 1 });
  });

  it("maps reserve sync coverage states, unavailability, and score-grade proof badges", () => {
    const liveCoin = makeCoin({ liveReservesConfig: LIVE_RESERVE_CONFIGS.live });
    expect(reserveCoverageFeature.resolve(liveCoin, true).kind).toBe("live");
    expect(reserveCoverageFeature.resolve(liveCoin, false)).toMatchObject({ kind: "live-configured", available: false });
    expect(reserveCoverageFeature.resolve(liveCoin, null).kind).toBe("checking");
    expect(reserveCoverageFeature.resolve(makeCoin({ liveReservesConfig: LIVE_RESERVE_CONFIGS.curatedValidated }), false).kind).toBe("curated-validated");
    expect(reserveCoverageFeature.resolve(makeCoin({ liveReservesConfig: LIVE_RESERVE_CONFIGS.proof }), false).kind).toBe("proof");
    expect(reserveCoverageFeature.resolve(makeCoin({ reserves: CURATED_RESERVES })).kind).toBe("curated");
    expect(reserveCoverageFeature.resolve(makeCoin()).kind).toBe("estimated");
    expect(reserveCoverageFeature.resolve(makeCoin({ reserves: CURATED_RESERVES }), true, false)).toMatchObject({ kind: "data-unavailable", available: false, label: "Data n/a" });

    const tetherCoin = makeCoin({ liveReservesConfig: { adapter: "tether-transparency", version: 1, semantics: "collateral-mix", inputs: { primary: { kind: "http-json", url: "https://example.com/reserves" } }, params: { currencyIso: "USD" } } });
    expect(reserveCoverageFeature.resolve(tetherCoin, false).kind).toBe("proof");
    expect(reserveCoverageFeature.resolve(tetherCoin, true).kind).toBe("live");
  });

  it.each([
    [{ score: null, resolutionState: "missing-capacity" as const, modelConfidence: "low" as const }, "configured-unrated", "Config."],
    [{ modelConfidence: "low" as const }, "modeled-heuristic", "Heur."],
    [{ score: null, resolutionState: "impaired" as const, routeStatus: "degraded" as const, routeStatusSource: "market-implied" as const, routeStatusReason: "Active severe depeg requires current live-open evidence.", modelConfidence: "low" as const }, "impaired", "Impaired"],
    [{ score: 65, modelConfidence: "medium" as const, capacitySemantics: "eventual-only" as const }, "resolved-unscored", "Resolved"],
  ])("classifies non-strong redemption row %j as %s", (overrides, kind, label) => {
    const status = redemptionCoverageFeature.resolve(makeRedemptionEntry(overrides));
    expect(status).toMatchObject({ kind, available: false, label });
    if (kind === "impaired") expect(status.detail).toContain("Active severe depeg");
  });

  it("maps flows, blacklist, MiCA, and GENIUS states cleanly", () => {
    expect(flowCoverageFeature.resolve("full").label).toBe("Full");
    expect(flowCoverageFeature.resolve("partial-history").label).toBe("Partial");
    expect(flowCoverageFeature.resolve("bootstrapping")).toMatchObject({ kind: "bootstrapping", spokenLabel: "Bootstrapping" });
    expect(flowCoverageFeature.resolve("unknown").label).toBe("Unknown");
    expect(flowCoverageFeature.resolve("lagging")).toMatchObject({ kind: "tracked", label: "Tracked", available: true });
    expect(flowCoverageFeature.statusKinds).not.toContain("lagging");
    expect(JSON.stringify(flowCoverageFeature.legendItems)).not.toMatch(/Lagging/);
    expect(flowCoverageFeature.resolve(null).available).toBe(false);

    for (const [sym, val, kind] of [["tGBP", true, "live"], ["YES", true, "yes"], ["USDT", "possible", "possible"], ["DAI", "inherited", "upstream"], ["USDQ", false, "no"], ["TBD", null, "data-unavailable"]] as const) {
      expect(blacklistCoverageFeature.resolve(makeCoin({ symbol: sym }), val).kind).toBe(kind);
    }

    const micaAuth = micaCoverageFeature.resolve({ status: "authorized", tokenType: "EMT", competentAuthority: "ACPR" });
    expect(micaAuth).toMatchObject({ kind: "authorized", label: "Authorized", available: true });
    expect(micaAuth.detail).toContain("Token type: EMT.");
    expect(micaAuth.detail).toContain("Authority: ACPR.");
    expect(micaCoverageFeature.resolve({ status: "out-of-scope" })).toMatchObject({ kind: "out-of-scope", available: true });
    expect(micaCoverageFeature.resolve(null)).toMatchObject({ kind: "unassessed", label: "Not Assessed", available: false });

    expect(geniusCoverageFeature.resolve({ authorizationStatus: "issuer-announced-intent" })).toMatchObject({ kind: "issuer-announced-intent", label: "Issuer Intent", available: true });
    expect(geniusCoverageFeature.resolve({ authorizationStatus: "no-public-authorization-found" })).toMatchObject({ kind: "no-public-authorization-found", label: "None Found", available: true });
    expect(geniusCoverageFeature.resolve(null)).toMatchObject({ kind: "unassessed", label: "Not Assessed", available: false });
  });

  it("emits role-aware dependency coverage states and separates gaps from outages", () => {
    for (const [fact, expected] of [
      [{ kind: "both", upstreamCount: 2, dependentCount: 1 }, { kind: "both" }],
      [{ kind: "dependent", upstreamCount: 1, dependentCount: 0 }, { kind: "dependent" }],
      [{ kind: "upstream", upstreamCount: 0, dependentCount: 2 }, { kind: "upstream" }],
      [{ kind: "resolved-none", upstreamCount: 0, dependentCount: 0 }, { available: true }],
      [{ kind: "unmapped-gap", upstreamCount: 0, dependentCount: 0 }, { available: false }],
    ] as const) {
      expect(dependencyCoverageFeature.resolve(fact)).toMatchObject(expected);
    }
    for (const fact of [null, undefined] as const) {
      expect(dependencyCoverageFeature.resolve(fact)).toMatchObject({ kind: "unmapped-gap", available: false });
      expect(dependencyCoverageFeature.resolve(fact, false)).toMatchObject({ kind: "data-unavailable", available: false });
      expect(makeCoverageRow(["absent", "ABS"], { dependencyCoverage: fact }).statuses.dependency.kind).toBe("unmapped-gap");
    }
    const summary = buildCoverageFeatureSummary(coverageFeature("dependency"), [
      makeCoverageRow(["gap", "GAP"], { dependencyCoverage: { kind: "unmapped-gap", upstreamCount: 0, dependentCount: 0 } }),
      makeCoverageRow(["unavailable", "DNA"], { dependencyCoverage: null, dataAvailability: { dependency: false } }),
    ]);
    expect(summary.breakdown).toContainEqual({ key: "gaps", label: "gaps", count: 1 });
    expect(summary.breakdown).toContainEqual({ key: "data-unavailable", label: "data n/a", count: 1 });
  });

  it("maps mint-authority summaries and preserves curated bucket when report cards are unavailable", () => {
    expect(mintAuthorityCoverageFeature.resolve(null)).toMatchObject({ kind: "unknown", available: false });
    const immutable: MintAuthorityCoverageSummary = { mintPath: "immutable-user-collateralized", authorityPosture: "none-resolved", confidence: "verified" };
    expect(mintAuthorityCoverageFeature.resolve(immutable, { score: 92, posture: "none-resolved" }, true)).toMatchObject({ kind: "no-privileged-mint", score: 92, scoreBand: "hardened" });
    expect(mintAuthorityCoverageFeature.resolve(immutable, { score: 92, posture: "none-resolved" }, false)).toMatchObject({ kind: "no-privileged-mint", available: true, score: null, scoreBand: "data-unavailable" });
    for (const [summary, kind] of [
      [{ mintPath: "bridge-or-oft-synthetic", authorityPosture: "partially-bounded-admin", confidence: "manual-review" }, "bridge-mint"],
      [{ mintPath: "permissioned-minter", authorityPosture: "bounded-admin", confidence: "verified", controls: [{ label: "Minter admin", authorityType: "safe", directMintAbility: "can-authorize" }] }, "multisig-mint"],
      [{ mintPath: "issuer-direct-mint", authorityPosture: "bounded-admin", confidence: "verified" }, "issuer-or-backend-mint"],
      [{ mintPath: "permissioned-minter", authorityPosture: "unbounded-adverse", confidence: "manual-review", controls: [{ label: "Direct minter", authorityType: "unknown", directMintAbility: "direct" }] }, "issuer-or-backend-mint"],
      [{ mintPath: "wrapped-or-variant-inherited", authorityPosture: "bounded-admin", confidence: "probable" }, "inherited-authority"],
    ] as const) {
      expect(mintAuthorityCoverageFeature.resolve(summary as unknown as MintAuthorityCoverageSummary).kind).toBe(kind);
    }
  });

  it("counts only available features when building rows", () => {
    const row = makeCoverageRow(["test-usd", "TUSDX"], { coin: makeCoin({ reserves: CURATED_RESERVES }), marketCapUsd: 1_000_000, redemptionEntry: makeRedemptionEntry(), flowCoverageStatus: "partial-history" });
    expect(row).toMatchObject({ coverageCount: 6, headlineCoverageCount: 4, advancedCoverageCount: 5 });
    expect(row.statuses.yield.available).toBe(false);
    expect(row.statuses.blacklist.available).toBe(false);
    expect(row.statuses.redemption.label).toBe("PSM");
    expect(row.statuses.mintAuthority.available).toBe(false);
  });

  it("summarizes Price with observed-depth populations, source-depth buckets, and empty denominators", () => {
    const baseSummary = buildCoverageFeatureSummary(coverageFeature("price"), [
      makeCoverageRow(["one", "ONE"], { coin: makeCoin({ reserves: CURATED_RESERVES }), marketCapUsd: 800, consensusSources: ["coingecko", "defillama-list", "pyth"], priceConfidence: "high", redemptionEntry: makeRedemptionEntry(), hasYieldCoverage: true, flowCoverageStatus: "full", dependencyCoverage: { kind: "dependent", upstreamCount: 1, dependentCount: 0 } }),
      makeCoverageRow(["two", "TWO"], { coin: makeNavCoin(), marketCapUsd: 200, hasPegCoverage: false, safetyScore: null, safetyRatingStatus: "not-rated", dexCoverageClass: "unobserved" }),
    ]);
    expect(baseSummary).toMatchObject({ availableCount: 1, totalCount: 1, coveragePct: 100, mcapSharePct: 100 });
    expect(baseSummary.breakdown).toEqual([
      { key: "tracked", label: "tracked", count: 1 }, { key: "price-only", label: "price-only", count: 1 },
      { key: "sources-5-plus", label: "5+ sources:", count: 0 }, { key: "sources-3-4", label: "3-4:", count: 1 }, { key: "sources-1-2", label: "0-2:", count: 0 },
    ]);

    const mixedSummary = buildCoverageFeatureSummary(coverageFeature("price"), [
      makeCoverageRow(["three", "THR"], { marketCapUsd: 500, consensusSources: ["a", "b", "c"] }),
      makeCoverageRow(["one", "ONE"], { marketCapUsd: 300, consensusSources: ["a"] }),
      makeCoverageRow(["missing", "MIS"], { marketCapUsd: 100, hasPegCoverage: false }),
      makeCoverageRow(["unknown", "UNK"], { marketCapUsd: 1_000, hasPegCoverage: true }),
      makeCoverageRow(["nav", "NAV"], { marketCapUsd: 5_000, coin: makeNavCoin() }),
      makeCoverageRow(["dark", "DRK"], { marketCapUsd: 7_000, dataAvailability: { price: false } }),
    ]);
    expect(mixedSummary).toMatchObject({ availableCount: 1, totalCount: 3, coveredMcapUsd: 500, marketCapObservedCount: 3, marketCapComplete: false, mcapSharePct: (500 / 900) * 100 });
    expect(mixedSummary.coveragePct).toBeCloseTo(100 / 3, 10);
    expect(mixedSummary.shareLabel).toContain("known market cap");
    expect(mixedSummary.breakdown).toContainEqual({ key: "price-only", label: "price-only", count: 1 });
    expect(mixedSummary.breakdown).toContainEqual({ key: "data-unavailable", label: "data n/a", count: 1 });

    expect(buildCoverageFeatureSummary(coverageFeature("price"), [makeCoverageRow(["nav", "NAV"], { coin: makeNavCoin() })]))
      .toMatchObject({ availableCount: 0, totalCount: 0, coveragePct: null, coverageUnavailable: false, coverageLabel: "n/a" });

    const depthSummary = buildCoverageFeatureSummary(coverageFeature("price"), [
      makeCoverageRow(["deep", "DEEP"], { marketCapUsd: 500, consensusSources: ["a", "b", "c", "d", "e"] }),
      makeCoverageRow(["shallow", "SHAL"], { marketCapUsd: 500, consensusSources: ["a"] }),
      makeCoverageRow(["zero", "ZERO"], { marketCapUsd: 500, consensusSources: [] }),
    ]);
    expect(depthSummary.breakdown).toEqual(expect.arrayContaining([
      { key: "tracked", label: "tracked", count: 3 }, { key: "sources-5-plus", label: "5+ sources:", count: 1 },
      { key: "sources-3-4", label: "3-4:", count: 0 }, { key: "sources-1-2", label: "0-2:", count: 2 },
    ]));

    const unmeasured = buildCoverageFeatureSummary(coverageFeature("price"), [
      makeCoverageRow(["measured", "MEAS"], { marketCapUsd: 500, consensusSources: ["a", "b", "c"] }),
      makeCoverageRow(["unknown", "UNK"], { marketCapUsd: 500 }),
    ]);
    expect(unmeasured.breakdown).toContainEqual({ key: "tracked", label: "tracked", count: 2 });
    expect(unmeasured.breakdown.some((i) => i.key.startsWith("sources-"))).toBe(false);
  });

  it("preserves unavailable subtotals, explicit-zero caps, and partial market-cap reach", () => {
    expect(buildCoverageFeatureSummary(coverageFeature("price"), [])).toMatchObject({ availableCount: 0, totalCount: 0, coveragePct: 0, coveredMcapUsd: null, mcapSharePct: null });

    expect(buildCoverageFeatureSummary(coverageFeature("blacklist"), [
      makeCoverageRow(["freezable", "FRZ"], { marketCapUsd: 0, blacklistStatus: false }),
      makeCoverageRow(["tracked", "TRK"], { marketCapUsd: 0, blacklistStatus: true }),
    ])).toMatchObject({ coveragePct: 100, mcapSharePct: null, coveredMcapUsd: 0, marketCapObservedCount: 2, marketCapComplete: true });

    const known = makeCoverageRow(["known", "KNW"], { hasYieldCoverage: true, marketCapUsd: 100 });
    const unknown = makeCoverageRow(["unknown", "UNK"], { hasYieldCoverage: false, marketCapAvailable: false });
    const partial = buildCoverageFeatureSummary(coverageFeature("yield"), [known, unknown]);
    expect(partial).toMatchObject({ coveredMcapUsd: 100, marketCapObservedCount: 1, marketCapComplete: false, mcapSharePct: 100 });
    expect(partial.shareLabel).toMatch(/known market cap/i);
    expect(buildCoverageFeatureSummary(coverageFeature("yield"), [unknown])).toMatchObject({ coveredMcapUsd: null, marketCapObservedCount: 0, marketCapComplete: false, mcapSharePct: null });
    expect(buildCoverageFeatureSummary(coverageFeature("yield"), [known, { ...unknown, marketCapAvailable: true, marketCapUsd: 100 }]))
      .toMatchObject({ marketCapObservedCount: 2, marketCapComplete: true, mcapSharePct: 50 });
  });

  it("respects scopeFilter and lets headlineFilter take precedence over headlineKinds", () => {
    const fmt = (_rows: unknown, map: ReadonlyMap<string, number>) => Array.from(map, ([key, count]) => ({ key, label: key, count }));
    const scoped: CoverageFeatureDefinition = { key: "safety", label: "Scoped", shortLabel: "Safety", description: "Scoped.", scopeFilter: (r) => r.id !== "excluded", statusKinds: ["graded"], legendItems: [], formatBreakdown: fmt };
    expect(buildCoverageFeatureSummary(scoped, [makeCoverageRow(["excluded", "EXC"], { marketCapUsd: 9_000 }), makeCoverageRow(["kept", "KEPT"], { marketCapUsd: 1_000 })]))
      .toMatchObject({ availableCount: 1, totalCount: 1, coveragePct: 100, coveredMcapUsd: 1_000, mcapSharePct: 100 });

    const conflicting: CoverageFeatureDefinition = { key: "dex", label: "Conflicting", shortLabel: "DEX", description: "Conflict.", headlineFilter: (r) => r.statuses.dex.kind === "primary", headlineKinds: ["fallback"], statusKinds: ["primary", "fallback"], legendItems: [], formatBreakdown: fmt };
    expect(buildCoverageFeatureSummary(conflicting, [makeCoverageRow(["primary", "PRI"], { marketCapUsd: 300, dexCoverageClass: "primary" }), makeCoverageRow(["fallback", "FALL"], { marketCapUsd: 700, dexCoverageClass: "fallback" })]))
      .toMatchObject({ availableCount: 1, coveragePct: 50, coveredMcapUsd: 300, mcapSharePct: 30 });
  });

  it("summarizes mint-authority, compliance, reserves, redemption, blacklist, and yield outages", () => {
    const mintRows = [
      makeCoverageRow(["reviewed", "REV"], { coin: makeCoin({ mintAuthoritySummary: { mintPath: "issuer-direct-mint", authorityPosture: "concentrated-admin", confidence: "verified" } }), marketCapUsd: 800, safetyScore: null, safetyRatingStatus: "not-rated", dexCoverageClass: null }),
      makeCoverageRow(["unknown", "UNK"], { marketCapUsd: 200, safetyScore: null, safetyRatingStatus: "not-rated", dexCoverageClass: null }),
    ];
    const mintSummary = buildCoverageFeatureSummary(coverageFeature("mintAuthority"), mintRows);
    expect(mintSummary).toMatchObject({ countLabel: "Reviewed authority", availableCount: 1, coveragePct: 50, mcapSharePct: 80, coverageLabel: "50% with reviewed mint authority" });
    expect(mintSummary.breakdown).toEqual(expect.arrayContaining([
      { key: "issuer-or-backend-mint", label: "issuer/backend", count: 1 }, { key: "unknown", label: "unknown", count: 1 }, { key: "score-nr", label: "NR", count: 2 },
    ]));
    expect(mintRows[0].statuses.mintAuthority).toMatchObject({ score: null, scoreBand: "nr" });

    const compRows = [
      makeCoverageRow(["assessed", "ASM"], { coin: { ...makeCoin(), mica: { status: "authorized", tokenType: "EMT" }, genius: { authorizationStatus: "issuer-announced-intent" } }, marketCapUsd: 800 }),
      makeCoverageRow(["missing", "MIS"], { marketCapUsd: 200 }),
    ];
    const micaSummary = buildCoverageFeatureSummary(coverageFeature("mica"), compRows);
    expect(micaSummary).toMatchObject({ countLabel: "Assessed assets", availableCount: 1, coveragePct: 50, mcapSharePct: 80, coverageLabel: "50% with MiCA assessment" });
    expect(micaSummary.breakdown).toEqual(expect.arrayContaining([{ key: "authorized", label: "authorized", count: 1 }, { key: "unassessed", label: "not assessed", count: 1 }]));
    const geniusSummary = buildCoverageFeatureSummary(coverageFeature("genius"), compRows);
    expect(geniusSummary).toMatchObject({ countLabel: "Assessed assets", availableCount: 1, coveragePct: 50, mcapSharePct: 80, coverageLabel: "50% with GENIUS assessment" });
    expect(geniusSummary.breakdown).toEqual(expect.arrayContaining([{ key: "issuer-announced-intent", label: "issuer intent", count: 1 }, { key: "unassessed", label: "not assessed", count: 1 }]));

    const resSummary = buildCoverageFeatureSummary(coverageFeature("reserves"), [
      makeCoverageRow(["live", "LIVE"], { coin: makeCoin({ liveReservesConfig: LIVE_RESERVE_CONFIGS.live }), marketCapUsd: 700, liveReserveFresh: true }),
      makeCoverageRow(["validated", "VAL"], { coin: makeCoin({ liveReservesConfig: LIVE_RESERVE_CONFIGS.curatedValidated }), liveReserveFresh: false }),
      makeCoverageRow(["proof", "PROOF"], { coin: makeCoin({ liveReservesConfig: LIVE_RESERVE_CONFIGS.proof }), liveReserveFresh: false }),
      makeCoverageRow(["curated", "CUR"], { coin: makeCoin({ reserves: CURATED_RESERVES }), marketCapUsd: 300 }),
    ]);
    expect(resSummary).toMatchObject({ countLabel: "Score-grade live", availableCount: 1, totalCount: 4, coveragePct: 25, shareLabel: "Score-grade live reserve market-cap reach", coverageLabel: "25% with score-grade live reserves" });
    expect(resSummary.mcapSharePct).toBeCloseTo(58.333, 3);
    expect(resSummary.breakdown).toEqual([
      { key: "live", label: "score-grade", count: 1 }, { key: "live-configured", label: "configured", count: 0 }, { key: "checking", label: "checking", count: 0 },
      { key: "curated-validated", label: "curated-validated", count: 1 }, { key: "proof", label: "proof", count: 1 }, { key: "curated", label: "curated", count: 1 },
      { key: "estimated", label: "estimated", count: 0 }, { key: "data-unavailable", label: "data n/a", count: 0 },
    ]);

    const resOutage = buildCoverageFeatureSummary(coverageFeature("reserves"), [
      makeCoverageRow(["live", "LIVE"], { coin: makeCoin({ liveReservesConfig: LIVE_RESERVE_CONFIGS.live }), liveReserveFresh: true, dataAvailability: { reserves: false } }),
      makeCoverageRow(["curated", "CUR"], { dataAvailability: { reserves: false } }),
    ]);
    expect(resOutage).toMatchObject({ availableCount: 0, totalCount: 0, coveragePct: null, marketCapComplete: false });
    expect(resOutage.breakdown).toContainEqual({ key: "data-unavailable", label: "data n/a", count: 2 });
    expect(resOutage.breakdown.filter((i) => i.key !== "data-unavailable" && i.count > 0)).toEqual([]);

    const redSummary = buildCoverageFeatureSummary(coverageFeature("redemption"), [
      makeCoverageRow(["issuer", "ISS"], { marketCapUsd: 500, redemptionEntry: makeRedemptionEntry({ routeFamily: "offchain-issuer" }) }),
      makeCoverageRow(["psm", "PSM"], { marketCapUsd: 300, redemptionEntry: makeRedemptionEntry({ routeFamily: "psm-swap" }) }),
      makeCoverageRow(["heuristic", "HEUR"], { marketCapUsd: 150, redemptionEntry: makeRedemptionEntry({ routeFamily: "stablecoin-redeem", modelConfidence: "low", capacityConfidence: "heuristic" }) }),
      makeCoverageRow(["eventual", "EVT"], { marketCapUsd: 75, redemptionEntry: makeRedemptionEntry({ routeFamily: "offchain-issuer", capacitySemantics: "eventual-only" }) }),
      makeCoverageRow(["impaired", "IMP"], { marketCapUsd: 25, redemptionEntry: makeRedemptionEntry({ score: null, resolutionState: "impaired", routeStatus: "degraded", modelConfidence: "low" }) }),
      makeCoverageRow(["none", "NON"], { marketCapUsd: 50 }),
    ]);
    expect(redSummary).toMatchObject({ countLabel: "Strong coverage", availableCount: 2, totalCount: 6, coverageLabel: "33% with strong redemption coverage", shareLabel: "Strong redemption market-cap reach" });
    expect(redSummary.coveragePct).toBeCloseTo(33.333, 3);
    expect(redSummary.mcapSharePct).toBeCloseTo(72.727, 3);
    expect(redSummary.breakdown).toEqual([
      { key: "modeled-heuristic", label: "heuristic", count: 1 }, { key: "resolved-unscored", label: "resolved", count: 1 }, { key: "configured-unrated", label: "configured", count: 0 },
      { key: "impaired", label: "impaired", count: 1 }, { key: "offchain-issuer", label: "issuer", count: 1 }, { key: "psm-swap", label: "psm", count: 1 },
      { key: "queue-redeem", label: "queue", count: 0 }, { key: "collateral-redeem", label: "collateral", count: 0 }, { key: "stablecoin-redeem", label: "stable", count: 0 },
      { key: "basket-redeem", label: "basket", count: 0 }, { key: "data-unavailable", label: "data n/a", count: 0 },
    ]);

    const blSummary = buildCoverageFeatureSummary(coverageFeature("blacklist"), [
      makeCoverageRow(["tracked", "USDC"], { marketCapUsd: 700, blacklistStatus: true }),
      makeCoverageRow(["untracked", "YES"], { marketCapUsd: 200, blacklistStatus: true }),
      makeCoverageRow(["possible", "USDT"], { marketCapUsd: 500, blacklistStatus: "possible" }),
      makeCoverageRow(["not-blacklistable", "NO"], { blacklistStatus: false }),
    ]);
    expect(blSummary).toMatchObject({ countLabel: "Statuses resolved", availableCount: 4, totalCount: 4, coveragePct: 100, mcapSharePct: 100, coverageLabel: "100% with resolved freezable status", shareLabel: "Resolved status market-cap reach" });
    expect(blSummary.breakdown).toEqual([
      { key: "live", label: "live", count: 1 }, { key: "yes", label: "yes", count: 1 }, { key: "upstream", label: "upstream", count: 0 },
      { key: "possible", label: "possible", count: 1 }, { key: "no", label: "no", count: 1 },
    ]);

    const allOutage = buildCoverageFeatureSummary(coverageFeature("yield"), [
      makeCoverageRow(["dark", "DARK"], { dataAvailability: { yield: false } }),
      makeCoverageRow(["darker", "DARK2"], { dataAvailability: { yield: false } }),
    ]);
    expect(allOutage).toMatchObject({ coveragePct: null, coverageUnavailable: true, availableCount: 0, totalCount: 0, coveredMcapUsd: null, mcapSharePct: null, coverageLabel: "Data n/a" });
    expect(allOutage.breakdown).toContainEqual({ key: "data-unavailable", label: "data n/a", count: 2 });

    const partialYield = buildCoverageFeatureSummary(coverageFeature("yield"), [
      makeCoverageRow(["ranked", "RANK"], { hasYieldCoverage: true, marketCapUsd: 300 }),
      makeCoverageRow(["gap", "GAP"], { marketCapUsd: 100 }),
      makeCoverageRow(["dark", "DARK"], { dataAvailability: { yield: false }, marketCapUsd: 600 }),
    ]);
    expect(partialYield).toMatchObject({ availableCount: 1, totalCount: 2, coveragePct: 50, mcapSharePct: 75 });
    expect(partialYield.breakdown).toEqual([
      { key: "covered", label: "covered", count: 1 }, { key: "uncovered", label: "uncovered", count: 1 }, { key: "data-unavailable", label: "data n/a", count: 1 },
    ]);
  });
});
