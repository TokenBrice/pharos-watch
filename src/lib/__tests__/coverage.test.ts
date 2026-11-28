import { describe, expect, it } from "vitest";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import type { MintAuthorityCoverageSummary } from "@shared/types/stablecoin-client-meta";
import type { CoverageFeatureDefinition, CoverageFeatureKey } from "@/lib/coverage-types";
import { buildCoverageFeatureSummary as buildSummary, buildCoverageRow, COVERAGE_FEATURES } from "@/lib/coverage";
import { coverageFeature as blacklist } from "@/lib/coverage/blacklist";
import { coverageFeature as dependency } from "@/lib/coverage/dependency";
import { coverageFeature as dex } from "@/lib/coverage/dex";
import { coverageFeature as flows } from "@/lib/coverage/flows";
import { coverageFeature as genius } from "@/lib/coverage/genius";
import { coverageFeature as mintAuthority } from "@/lib/coverage/mint-authority";
import { coverageFeature as mica } from "@/lib/coverage/mica";
import { coverageFeature as price } from "@/lib/coverage/price";
import { coverageFeature as redemption } from "@/lib/coverage/redemption";
import { coverageFeature as reserves } from "@/lib/coverage/reserves";
import { coverageFeature as safety } from "@/lib/coverage/safety";
import { matchesCoverageFilter as matchesFilter } from "@/lib/coverage-filtering";
import { makeStablecoinMeta } from "@shared/test-utils/stablecoin";

type TestCoin = StablecoinMeta & { mintAuthoritySummary?: MintAuthorityCoverageSummary };
const mkFlags = (p: Partial<StablecoinMeta["flags"]> = {}): StablecoinMeta["flags"] => ({ ...makeStablecoinMeta().flags, rwa: true, ...p });
const mkCoin = (ov?: Partial<TestCoin>): TestCoin => makeStablecoinMeta({ id: "test-usd", name: "Test USD", symbol: "TUSDX", flags: mkFlags(), ...ov });
const navCoin = (yieldBearing = false): TestCoin => mkCoin({ flags: mkFlags({ backing: "rwa-backed", governance: "centralized", pegCurrency: "USD", yieldBearing, navToken: true }) });

const mkRed = (ov?: Partial<RedemptionBackstopEntry>): RedemptionBackstopEntry => ({
  stablecoinId: "test-usd", score: 72, dexLiquidityScore: 58, accessScore: 100, settlementScore: 100,
  executionCertaintyScore: 100, capacityScore: 60, outputAssetQualityScore: 100, costScore: 40,
  routeFamily: "psm-swap", accessModel: "permissionless-onchain", settlementModel: "atomic",
  executionModel: "deterministic-onchain", outputAssetType: "stable-single", provider: "supply-ratio-model",
  sourceMode: "estimated", resolutionState: "resolved", routeStatus: "open", routeStatusSource: "static-config",
  holderEligibility: "any-holder", capacityConfidence: "documented-bound", capacitySemantics: "immediate-bounded",
  feeConfidence: "undisclosed-reviewed", feeModelKind: "undisclosed-reviewed", modelConfidence: "medium",
  immediateCapacityUsd: 10_000_000, immediateCapacityRatio: 0.15, feeBps: null, queueEnabled: false,
  methodologyVersion: "1.1", updatedAt: 1_700_000_000, ...ov,
});

const LIVE_CFG = {
  live: { adapter: "infinifi", version: 1, semantics: "collateral-mix", inputs: { primary: { kind: "http-json", url: "https://example.com/reserves" } } },
  curatedValidated: { adapter: "curated-validated", version: 1, semantics: "attestation-mix", inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } } },
  proof: { adapter: "single-asset", version: 1, semantics: "single-asset", inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } }, params: { label: "Issuer reserves", risk: "very-low" } },
} satisfies Record<string, NonNullable<StablecoinMeta["liveReservesConfig"]>>;

const CURATED: StablecoinMeta["reserves"] = [{ name: "Cash", pct: 100, risk: "very-low" }];
const CUR_COIN = mkCoin({ reserves: CURATED }), SRCS = ["coingecko", "defillama", "pyth"];
const NR = { safetyScore: null, safetyRatingStatus: "not-rated" as const };
const cfgCoin = (k: keyof typeof LIVE_CFG) => mkCoin({ liveReservesConfig: LIVE_CFG[k] });
const noData = (k: string) => ({ dataAvailability: { [k]: false } });
const featureOf = (k: CoverageFeatureKey) => COVERAGE_FEATURES.find((f) => f.key === k)!;
const row = (id: string, ov: Partial<Parameters<typeof buildCoverageRow>[0]> = {}, marketCapUsd = 100, symbol = id.toUpperCase()) => {
  const { coin, ...rest } = ov;
  return buildCoverageRow({
    coin: { ...(coin ?? mkCoin()), id, symbol }, marketCapUsd, hasPegCoverage: true, safetyScore: 82, safetyRatingStatus: "rated",
    dexCoverageClass: "primary", redemptionEntry: null, hasYieldCoverage: false, flowCoverageStatus: null,
    dependencyCoverage: { kind: "unmapped-gap", upstreamCount: 0, dependentCount: 0 }, ...rest,
  });
};
const sum = (k: CoverageFeatureKey, rows: ReturnType<typeof row>[]) => buildSummary(featureOf(k), rows);
type BkSpec = [string, number] | [string, string, number];
const bk = (spec: BkSpec) => spec.length === 2 ? { key: spec[0], label: spec[0], count: spec[1] } : { key: spec[0], label: spec[1], count: spec[2] };
const bks = (...specs: BkSpec[]) => specs.map(bk);
const dna = (count: number) => bk(["data-unavailable", "data n/a", count]);
const match = (a: unknown, b: object) => expect(a).toMatchObject(b);
const hasBk = (s: { breakdown: unknown[] }, items: unknown[]) => expect(s.breakdown).toEqual(expect.arrayContaining(items));

describe("coverage helpers", () => {
  it.each([
    ["genius", ["ppsi-approved", "state-qualified", "official-application-pending", "issuer-announced-intent", "no-public-authorization-found", "not-applicable", "unknown", "unassessed"]],
    ["mica", ["authorized", "pending", "transitional", "non-compliant", "out-of-scope", "unassessed"]],
    ["blacklist", ["live", "yes", "upstream", "possible", "no"]],
    ["safety", ["rated", "not-graded", "data-unavailable"]],
    ["yield", ["ranked"]],
  ] as const)("preserves the %s legend order and non-empty terms/descriptions", (key, expectedKinds) => {
    const items = featureOf(key).legendItems;
    expect(items.flatMap((i) => i.kinds)).toEqual([...expectedKinds]);
    for (const i of items) { expect(i.term.trim().length).toBeGreaterThan(0); expect(i.description.trim().length).toBeGreaterThan(0); }
  });

  it("keeps rated zero, genuine NR, and technical safety gaps in disjoint populations", () => {
    match(safety.resolve(0, "rated"), { kind: "rated", available: true });
    match(safety.resolve(null, "not-rated"), { kind: "nr", spokenLabel: "Not rated" });
    expect(safety.resolve(80, undefined).kind).toBe("data-unavailable");
    const gap = row("gap", { safetyScore: null, safetyRatingStatus: "pipeline-gap", safetyReasonCodes: ["single-pillar-pipeline-gap"] }, 700);
    const nr = row("nr", NR, 100), rated = row("zero", { safetyScore: 0 }, 200);
    match(gap.statuses.safety, { kind: "data-unavailable", label: "Data n/a", available: false });
    expect(gap.statuses.safety.detail).toContain("single-pillar-pipeline-gap");
    expect(gap.statuses.safety.spokenLabel).not.toMatch(/NR|Not rated/);
    expect([matchesFilter(gap, "missing-safety"), matchesFilter(nr, "missing-safety")]).toEqual([false, true]);
    const s = sum("safety", [rated, nr, gap]);
    match(s, { availableCount: 1, totalCount: 2, coveragePct: 50, mcapSharePct: 200 / 300 * 100 });
    expect(s.breakdown).toEqual([...bks(["rated", 1], ["nr", "NR", 1]), dna(1)]);

    const fund = row("buidl-blackrock", { coin: { ...mkCoin(), listingClass: "tokenized-fund" }, ...NR, safetyReasonCodes: ["tokenized-fund-not-graded"] }, 500, "BUIDL");
    match(fund.statuses.safety, { kind: "not-graded", label: "Not graded", available: false });
    expect([matchesFilter(fund, "missing-safety"), safety.resolve(null, "not-rated", true, ["tokenized-fund-not-graded"]).kind, safety.resolve(67, "rated", true, [], true).kind]).toEqual([false, "not-graded", "not-graded"]);
    const wf = sum("safety", [rated, nr, gap, fund]);
    match(wf, { availableCount: 1, totalCount: 2, coveragePct: 50, mcapSharePct: 200 / 300 * 100, marketCapComplete: false });
    expect(wf.breakdown).toEqual([...bks(["rated", 1], ["nr", "NR", 1], ["not-graded", "not graded", 1]), dna(1)]);
    match(sum("safety", [fund]), { availableCount: 0, totalCount: 0, coveragePct: null, coverageUnavailable: false, coverageLabel: "n/a" });
  });

  it("keeps market-cap reach unavailable when only uncovered rows have observed cap", () => {
    match(sum("yield", [row("covered", { hasYieldCoverage: true, marketCapAvailable: false }), row("uncovered", { hasYieldCoverage: false }, 100)]), { coveredMcapUsd: null, mcapSharePct: null, marketCapObservedCount: 1 });
  });

  it("handles NAV price-only, explicit current-price unavailability, and tracked source depths", () => {
    match(price.resolve(navCoin(true), false), { kind: "price-only", available: true });
    for (const c of [mkCoin(), navCoin(true)]) {
      const m = price.resolve(c, true, SRCS, "high", true);
      match(m, { kind: "missing", label: "Missing", available: false, detail: "No observed market price is available for this asset." });
      expect(m.sourceCount).toBeUndefined();
    }
    const r = row("unpriced", { consensusSources: SRCS, currentPriceUnavailable: true });
    match(r.statuses.price, { kind: "missing", available: false });
    expect([r.statuses.price.sourceCount, price.legendItems.find((i) => i.kinds.includes("missing"))?.description]).toEqual([undefined, "No observed market price is currently available for this asset."]);
    match(price.resolve(mkCoin(), true, SRCS, "high"), { kind: "tracked", sourceCount: 3, sourceNames: SRCS, priceConfidence: "high" });
    match(price.resolve(mkCoin(), true, [], "single-source"), { kind: "tracked", sourceCount: 0, sourceNames: [], priceConfidence: "single-source" });
  });

  it("maps DEX coverage classes and keeps missing classes out of denominators", () => {
    expect([dex.resolve("primary").label, dex.resolve("fallback").label, dex.resolve("unobserved").available]).toEqual(["Primary", "Fallback", false]);
    match(dex.resolve(null), { kind: "data-unavailable", available: false });

    const s = sum("dex", [row("unobserved", { dexCoverageClass: "unobserved" }), row("missing", { dexCoverageClass: null })]);
    match(s, { availableCount: 0, totalCount: 1, coveragePct: 0 });
    expect(s.breakdown).toContainEqual(dna(1));

    const leg = sum("dex", [row("legacy", { dexCoverageClass: "legacy" }), row("unobserved", { dexCoverageClass: "unobserved" })]);
    match(leg, { availableCount: 1, totalCount: 2 });
    expect(leg.breakdown).toContainEqual(bk(["legacy", 1]));
  });

  it("maps reserve sync coverage states, unavailability, and score-grade proof badges", () => {
    const liveCoin = cfgCoin("live"), res = reserves.resolve;
    expect([res(liveCoin, true).kind, res(liveCoin, null).kind, res(cfgCoin("curatedValidated"), false).kind, res(cfgCoin("proof"), false).kind, res(CUR_COIN).kind, res(mkCoin()).kind])
      .toEqual(["live", "checking", "curated-validated", "proof", "curated", "estimated"]);
    match(res(liveCoin, false), { kind: "live-configured", available: false });
    match(res(CUR_COIN, true, false), { kind: "data-unavailable", available: false, label: "Data n/a" });

    const tether = mkCoin({ liveReservesConfig: { adapter: "tether-transparency", version: 1, semantics: "collateral-mix", inputs: { primary: { kind: "http-json", url: "https://example.com/reserves" } }, params: { currencyIso: "USD" } } });
    expect([res(tether, false).kind, res(tether, true).kind]).toEqual(["proof", "live"]);
  });

  it.each([
    [{ score: null, resolutionState: "missing-capacity" as const, modelConfidence: "low" as const }, "configured-unrated", "Config."],
    [{ modelConfidence: "low" as const }, "modeled-heuristic", "Heur."],
    [{ score: null, resolutionState: "impaired" as const, routeStatus: "degraded" as const, routeStatusSource: "market-implied" as const, routeStatusReason: "Active severe depeg requires current live-open evidence.", modelConfidence: "low" as const }, "impaired", "Impaired"],
    [{ score: 65, modelConfidence: "medium" as const, capacitySemantics: "eventual-only" as const }, "resolved-unscored", "Resolved"],
  ])("classifies non-strong redemption row %j as %s", (ov, kind, label) => {
    const st = redemption.resolve(mkRed(ov));
    match(st, { kind, available: false, label });
    if (kind === "impaired") expect(st.detail).toContain("Active severe depeg");
  });

  it("maps flows, blacklist, MiCA, and GENIUS states cleanly", () => {
    expect([flows.resolve("full").label, flows.resolve("partial-history").label, flows.resolve("unknown").label, flows.resolve(null).available]).toEqual(["Full", "Partial", "Unknown", false]);
    match(flows.resolve("bootstrapping"), { kind: "bootstrapping", spokenLabel: "Bootstrapping" });
    match(flows.resolve("lagging"), { kind: "tracked", label: "Tracked", available: true });
    expect(flows.statusKinds).not.toContain("lagging");
    expect(JSON.stringify(flows.legendItems)).not.toMatch(/Lagging/);

    for (const [id, sym, val, kind] of [
      ["tgbp-tokenised", "tGBP", true, "live"], ["usdf-falcon", "USDf", true, "live"], ["usdf-astherus", "USDF", true, "yes"],
      ["test-yes", "YES", true, "yes"], ["usdt-tether", "USDT", "possible", "possible"], ["dai-makerdao", "DAI", "inherited", "upstream"],
      ["usdq-quantoz", "USDQ", false, "no"], ["test-tbd", "TBD", null, "data-unavailable"],
    ] as const) expect(blacklist.resolve(mkCoin({ id, symbol: sym }), val).kind).toBe(kind);

    const micaAuth = mica.resolve({ status: "authorized", tokenType: "EMT", competentAuthority: "ACPR" });
    match(micaAuth, { kind: "authorized", label: "Authorized", available: true });
    expect([micaAuth.detail.includes("Token type: EMT."), micaAuth.detail.includes("Authority: ACPR.")]).toEqual([true, true]);
    match(mica.resolve({ status: "out-of-scope" }), { kind: "out-of-scope", available: true });
    match(mica.resolve(null), { kind: "unassessed", label: "Not Assessed", available: false });
    match(genius.resolve({ authorizationStatus: "issuer-announced-intent" }), { kind: "issuer-announced-intent", label: "Issuer Intent", available: true });
    match(genius.resolve({ authorizationStatus: "no-public-authorization-found" }), { kind: "no-public-authorization-found", label: "None Found", available: true });
    match(genius.resolve(null), { kind: "unassessed", label: "Not Assessed", available: false });
  });

  it("emits role-aware dependency coverage states and separates gaps from outages", () => {
    for (const [fact, exp] of [
      [{ kind: "both", upstreamCount: 2, dependentCount: 1 }, { kind: "both" }],
      [{ kind: "dependent", upstreamCount: 1, dependentCount: 0 }, { kind: "dependent" }],
      [{ kind: "upstream", upstreamCount: 0, dependentCount: 2 }, { kind: "upstream" }],
      [{ kind: "resolved-none", upstreamCount: 0, dependentCount: 0 }, { available: true }],
      [{ kind: "unmapped-gap", upstreamCount: 0, dependentCount: 0 }, { available: false }],
    ] as const) match(dependency.resolve(fact), exp);
    for (const fact of [null, undefined] as const) {
      match(dependency.resolve(fact), { kind: "unmapped-gap", available: false });
      match(dependency.resolve(fact, false), { kind: "data-unavailable", available: false });
      expect(row("absent", { dependencyCoverage: fact }).statuses.dependency.kind).toBe("unmapped-gap");
    }
    hasBk(sum("dependency", [row("gap"), row("unavailable", { dependencyCoverage: null, ...noData("dependency") })]), [bk(["gaps", 1]), dna(1)]);
  });

  it("maps mint-authority summaries and preserves curated bucket when report cards are unavailable", () => {
    const ma = mintAuthority.resolve, imm: MintAuthorityCoverageSummary = { mintPath: "immutable-user-collateralized", authorityPosture: "none-resolved", confidence: "verified" };
    match(ma(null), { kind: "unknown", available: false });
    match(ma(imm, { score: 92, posture: "none-resolved" }, true), { kind: "no-privileged-mint", score: 92, scoreBand: "hardened" });
    match(ma(imm, { score: 92, posture: "none-resolved" }, false), { kind: "no-privileged-mint", available: true, score: null, scoreBand: "data-unavailable" });
    for (const [s, kind] of [
      [{ mintPath: "bridge-or-oft-synthetic", authorityPosture: "partially-bounded-admin", confidence: "manual-review" }, "bridge-mint"],
      [{ mintPath: "permissioned-minter", authorityPosture: "bounded-admin", confidence: "verified", controls: [{ label: "Minter admin", authorityType: "safe", directMintAbility: "can-authorize" }] }, "multisig-mint"],
      [{ mintPath: "issuer-direct-mint", authorityPosture: "bounded-admin", confidence: "verified" }, "issuer-or-backend-mint"],
      [{ mintPath: "permissioned-minter", authorityPosture: "unbounded-adverse", confidence: "manual-review", controls: [{ label: "Direct minter", authorityType: "unknown", directMintAbility: "direct" }] }, "issuer-or-backend-mint"],
      [{ mintPath: "wrapped-or-variant-inherited", authorityPosture: "bounded-admin", confidence: "probable" }, "inherited-authority"],
    ] as const) expect(ma(s as unknown as MintAuthorityCoverageSummary).kind).toBe(kind);
  });

  it("counts only available features when building rows", () => {
    const r = row("test-usd", { coin: CUR_COIN, redemptionEntry: mkRed(), flowCoverageStatus: "partial-history" }, 1_000_000, "TUSDX");
    match(r, { coverageCount: 6, headlineCoverageCount: 4, advancedCoverageCount: 5 });
    expect([r.statuses.yield.available, r.statuses.blacklist.available, r.statuses.redemption.label, r.statuses.mintAuthority.available]).toEqual([false, false, "PSM", false]);
  });

  it("summarizes Price with observed-depth populations, source-depth buckets, and empty denominators", () => {
    const base = sum("price", [
      row("one", { coin: CUR_COIN, consensusSources: ["coingecko", "defillama-list", "pyth"], priceConfidence: "high", redemptionEntry: mkRed(), hasYieldCoverage: true, flowCoverageStatus: "full", dependencyCoverage: { kind: "dependent", upstreamCount: 1, dependentCount: 0 } }, 800),
      row("two", { coin: navCoin(), hasPegCoverage: false, ...NR, dexCoverageClass: "unobserved" }, 200),
    ]);
    match(base, { availableCount: 1, totalCount: 1, coveragePct: 100, mcapSharePct: 100 });
    expect(base.breakdown).toEqual(bks(["tracked", 1], ["price-only", 1], ["sources-5-plus", "5+ sources:", 0], ["sources-3-4", "3-4:", 1], ["sources-1-2", "0-2:", 0]));

    const mixed = sum("price", [
      row("three", { consensusSources: ["a", "b", "c"] }, 500), row("one", { consensusSources: ["a"] }, 300),
      row("missing", { hasPegCoverage: false }, 100), row("unknown", { hasPegCoverage: true }, 1_000),
      row("nav", { coin: navCoin() }, 5_000), row("dark", noData("price"), 7_000),
    ]);
    match(mixed, { availableCount: 1, totalCount: 3, coveredMcapUsd: 500, marketCapObservedCount: 3, marketCapComplete: false, mcapSharePct: (500 / 900) * 100 });
    expect(mixed.coveragePct).toBeCloseTo(100 / 3, 10);
    expect(mixed.shareLabel).toContain("known market cap");
    hasBk(mixed, [bk(["price-only", 1]), dna(1)]);
    match(sum("price", [row("nav", { coin: navCoin() })]), { availableCount: 0, totalCount: 0, coveragePct: null, coverageUnavailable: false, coverageLabel: "n/a" });

    const depth = sum("price", [row("deep", { consensusSources: ["a", "b", "c", "d", "e"] }, 500), row("shallow", { consensusSources: ["a"] }, 500), row("zero", { consensusSources: [] }, 500)]);
    hasBk(depth, bks(["tracked", 3], ["sources-5-plus", "5+ sources:", 1], ["sources-3-4", "3-4:", 0], ["sources-1-2", "0-2:", 2]));

    const unm = sum("price", [row("measured", { consensusSources: ["a", "b", "c"] }, 500), row("unknown", {}, 500)]);
    expect(unm.breakdown).toContainEqual(bk(["tracked", 2]));
    expect(unm.breakdown.some((i) => i.key.startsWith("sources-"))).toBe(false);
  });

  it("preserves unavailable subtotals, explicit-zero caps, and partial market-cap reach", () => {
    match(sum("price", []), { availableCount: 0, totalCount: 0, coveragePct: 0, coveredMcapUsd: null, mcapSharePct: null });
    match(sum("blacklist", [row("freezable", { blacklistStatus: false }, 0), row("tracked", { blacklistStatus: true }, 0)]), { coveragePct: 100, mcapSharePct: null, coveredMcapUsd: 0, marketCapObservedCount: 2, marketCapComplete: true });

    const known = row("known", { hasYieldCoverage: true }, 100), unknown = row("unknown", { hasYieldCoverage: false, marketCapAvailable: false });
    const partial = sum("yield", [known, unknown]);
    match(partial, { coveredMcapUsd: 100, marketCapObservedCount: 1, marketCapComplete: false, mcapSharePct: 100 });
    expect(partial.shareLabel).toMatch(/known market cap/i);
    match(sum("yield", [unknown]), { coveredMcapUsd: null, marketCapObservedCount: 0, marketCapComplete: false, mcapSharePct: null });
    match(sum("yield", [known, { ...unknown, marketCapAvailable: true, marketCapUsd: 100 }]), { marketCapObservedCount: 2, marketCapComplete: true, mcapSharePct: 50 });
  });

  it("respects scopeFilter and lets headlineFilter take precedence over headlineKinds", () => {
    const fmt = (_r: unknown, map: ReadonlyMap<string, number>) => Array.from(map, ([k, c]) => bk([k, c]));
    const scoped: CoverageFeatureDefinition = { key: "safety", label: "Scoped", shortLabel: "Safety", description: "Scoped.", scopeFilter: (r) => r.id !== "excluded", statusKinds: ["graded"], legendItems: [], formatBreakdown: fmt };
    match(buildSummary(scoped, [row("excluded", {}, 9_000), row("kept", {}, 1_000)]), { availableCount: 1, totalCount: 1, coveragePct: 100, coveredMcapUsd: 1_000, mcapSharePct: 100 });

    const conflicting: CoverageFeatureDefinition = { key: "dex", label: "Conflicting", shortLabel: "DEX", description: "Conflict.", headlineFilter: (r) => r.statuses.dex.kind === "primary", headlineKinds: ["fallback"], statusKinds: ["primary", "fallback"], legendItems: [], formatBreakdown: fmt };
    match(buildSummary(conflicting, [row("primary", { dexCoverageClass: "primary" }, 300), row("fallback", { dexCoverageClass: "fallback" }, 700)]), { availableCount: 1, coveragePct: 50, coveredMcapUsd: 300, mcapSharePct: 30 });
  });

  it("summarizes mint-authority, compliance, reserves, redemption, blacklist, and yield outages", () => {
    const mintRows = [
      row("reviewed", { coin: mkCoin({ mintAuthoritySummary: { mintPath: "issuer-direct-mint", authorityPosture: "concentrated-admin", confidence: "verified" } }), ...NR, dexCoverageClass: null }, 800),
      row("unknown", { ...NR, dexCoverageClass: null }, 200),
    ];
    const mintS = sum("mintAuthority", mintRows);
    match(mintS, { countLabel: "Reviewed authority", availableCount: 1, coveragePct: 50, mcapSharePct: 80, coverageLabel: "50% with reviewed mint authority" });
    hasBk(mintS, bks(["issuer-or-backend-mint", "issuer/backend", 1], ["unknown", 1], ["score-nr", "NR", 2]));
    match(mintRows[0].statuses.mintAuthority, { score: null, scoreBand: "nr" });

    const compRows = [row("assessed", { coin: { ...mkCoin(), mica: { status: "authorized", tokenType: "EMT" }, genius: { authorizationStatus: "issuer-announced-intent" } } }, 800), row("missing", {}, 200)];
    const micaS = sum("mica", compRows);
    match(micaS, { countLabel: "Assessed assets", availableCount: 1, coveragePct: 50, mcapSharePct: 80, coverageLabel: "50% with MiCA assessment" });
    hasBk(micaS, bks(["authorized", 1], ["unassessed", "not assessed", 1]));
    const geniusS = sum("genius", compRows);
    match(geniusS, { countLabel: "Assessed assets", availableCount: 1, coveragePct: 50, mcapSharePct: 80, coverageLabel: "50% with GENIUS assessment" });
    hasBk(geniusS, bks(["issuer-announced-intent", "issuer intent", 1], ["unassessed", "not assessed", 1]));

    const resS = sum("reserves", [
      row("live", { coin: cfgCoin("live"), liveReserveFresh: true }, 700),
      row("validated", { coin: cfgCoin("curatedValidated"), liveReserveFresh: false }),
      row("proof", { coin: cfgCoin("proof"), liveReserveFresh: false }),
      row("curated", { coin: CUR_COIN }, 300),
    ]);
    match(resS, { countLabel: "Score-grade live", availableCount: 1, totalCount: 4, coveragePct: 25, shareLabel: "Score-grade live reserve market-cap reach", coverageLabel: "25% with score-grade live reserves" });
    expect(resS.mcapSharePct).toBeCloseTo(58.333, 3);
    expect(resS.breakdown).toEqual([...bks(["live", "score-grade", 1], ["live-configured", "configured", 0], ["checking", 0], ["curated-validated", 1], ["proof", 1], ["curated", 1], ["estimated", 0]), dna(0)]);

    const resOut = sum("reserves", [row("live", { coin: cfgCoin("live"), liveReserveFresh: true, ...noData("reserves") }), row("curated", noData("reserves"))]);
    match(resOut, { availableCount: 0, totalCount: 0, coveragePct: null, marketCapComplete: false });
    expect(resOut.breakdown).toContainEqual(dna(2));
    expect(resOut.breakdown.filter((i) => i.key !== "data-unavailable" && i.count > 0)).toEqual([]);

    const redS = sum("redemption", [
      row("issuer", { redemptionEntry: mkRed({ routeFamily: "offchain-issuer" }) }, 500),
      row("psm", { redemptionEntry: mkRed({ routeFamily: "psm-swap" }) }, 300),
      row("heuristic", { redemptionEntry: mkRed({ routeFamily: "stablecoin-redeem", modelConfidence: "low", capacityConfidence: "heuristic" }) }, 150),
      row("eventual", { redemptionEntry: mkRed({ routeFamily: "offchain-issuer", capacitySemantics: "eventual-only" }) }, 75),
      row("impaired", { redemptionEntry: mkRed({ score: null, resolutionState: "impaired", routeStatus: "degraded", modelConfidence: "low" }) }, 25),
      row("none", {}, 50),
    ]);
    match(redS, { countLabel: "Strong coverage", availableCount: 2, totalCount: 6, coverageLabel: "33% with strong redemption coverage", shareLabel: "Strong redemption market-cap reach" });
    expect(redS.coveragePct).toBeCloseTo(33.333, 3);
    expect(redS.mcapSharePct).toBeCloseTo(72.727, 3);
    expect(redS.breakdown).toEqual([...bks(["modeled-heuristic", "heuristic", 1], ["resolved-unscored", "resolved", 1], ["configured-unrated", "configured", 0], ["impaired", 1], ["offchain-issuer", "issuer", 1], ["psm-swap", "psm", 1], ["queue-redeem", "queue", 0], ["collateral-redeem", "collateral", 0], ["stablecoin-redeem", "stable", 0], ["basket-redeem", "basket", 0]), dna(0)]);

    const blS = sum("blacklist", [row("usdc-circle", { blacklistStatus: true }, 700, "USDC"), row("untracked", { blacklistStatus: true }, 200, "YES"), row("possible", { blacklistStatus: "possible" }, 500, "USDT"), row("not-blacklistable", { blacklistStatus: false }, 100, "NO")]);
    match(blS, { countLabel: "Statuses resolved", availableCount: 4, totalCount: 4, coveragePct: 100, mcapSharePct: 100, coverageLabel: "100% with resolved freezable status", shareLabel: "Resolved status market-cap reach" });
    expect(blS.breakdown).toEqual(bks(["live", 1], ["yes", 1], ["upstream", 0], ["possible", 1], ["no", 1]));

    const allOut = sum("yield", [row("dark", noData("yield")), row("darker", noData("yield"))]);
    match(allOut, { coveragePct: null, coverageUnavailable: true, availableCount: 0, totalCount: 0, coveredMcapUsd: null, mcapSharePct: null, coverageLabel: "Data n/a" });
    expect(allOut.breakdown).toContainEqual(dna(2));

    const partY = sum("yield", [row("ranked", { hasYieldCoverage: true }, 300), row("gap", {}, 100), row("dark", noData("yield"), 600)]);
    match(partY, { availableCount: 1, totalCount: 2, coveragePct: 50, mcapSharePct: 75 });
    expect(partY.breakdown).toEqual([...bks(["covered", 1], ["uncovered", 1]), dna(1)]);
  });
});
