import { describe, expect, it } from "vitest";
import type { LiveReserveAdapterKey, LiveReservesConfig } from "@shared/types/live-reserves";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import { ACTIVE_STABLECOINS, ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { makeCoverageCoin as coin } from "./helpers/coverage-coin";
import { REVIEWED_LIVE_RESERVE_SOURCE_NOTES as NOTES, buildReserveCoverageAudit as buildAudit, extractReserveStateRows as extractRows, renderReserveCoverageAuditMarkdown as renderMd } from "../maintenance/generate-reserve-coverage-audit";

type Rev = NonNullable<StablecoinMeta["reserveReview"]>;
const rev = (ov: Pick<Rev, "knownUnknownExposure" | "knownUnknownExposurePct"> & Partial<Rev>): Rev => ({
  reviewedAt: "2026-07-01", reviewer: "Fixture reviewer", confidence: "verified", sources: [{ label: "Review", url: "https://example.com/review" }], rationale: "Fixture review rationale", compositionBasis: "Fixture disclosure", compositionAsOf: "2026-07-01", scope: "full-composition", ...ov,
});
const noUnk = rev({ knownUnknownExposure: "No material known unknown exposure.", knownUnknownExposurePct: 0 });
const liveCfg = (adapter: LiveReserveAdapterKey): LiveReservesConfig => ({ adapter, version: 1, semantics: "collateral-mix", display: { url: `https://example.com/${adapter}` }, inputs: { primary: { kind: "http-json", url: `https://example.com/${adapter}.json` } }, params: {} });

const activeCoins = [
  coin({ id: "live-a", symbol: "LIVA", reserves: [{ name: "USDC", pct: 60, risk: "low", coinId: "usdc-circle" }, { name: "Cash", pct: 40, risk: "very-low" }], liveReservesConfig: liveCfg("accountable") }),
  coin({ id: "live-b", symbol: "LIVB", reserves: [{ name: "Treasuries", pct: 55, risk: "very-low" }, { name: "Stablecoin basket", pct: 9, risk: "low" }], liveReservesConfig: liveCfg("curated-validated") }),
  coin({ id: "live-c", symbol: "LIVC", reserves: [{ name: "Single token", pct: 100, risk: "low", coinId: "usdt-tether" }], liveReservesConfig: liveCfg("single-asset") }),
  coin({ id: "plain", symbol: "PLN", name: "Plain Coin", reserves: [{ name: "Cash", pct: 100, risk: "very-low" }] }),
  coin({ id: "usdo-openeden", symbol: "USDO", name: "OpenEden USDO", reserves: [{ name: "US Treasuries", pct: 100, risk: "low", coinId: "usdc-circle" }] }),
] satisfies StablecoinMeta[];
const scPay = { peggedAssets: [{ id: "plain", circulating: { peggedUSD: 20_000_000 } }, { id: "usdo-openeden", circulating: { peggedUSD: 10_000_000 } }] };

describe("generate-reserve-coverage-audit", () => {
  it("keeps source-quality dispositions on active effective-unconfigured assets and propagates their evidence", () => {
    const a = buildAudit({ activeCoins: ACTIVE_STABLECOINS }), cands = [...a.curatedOnlyActiveCandidates, ...a.unconfiguredWithoutCuratedReserves];
    for (const [id, note] of Object.entries(NOTES)) {
      const m = ACTIVE_META_BY_ID.get(id); expect(m, id).toBeDefined(); expect(m?.liveReservesConfig, id).toBeUndefined();
      const c = cands.find((r) => r.coinId === id);
      expect(c, id).toMatchObject({ sourceUrl: note.sourceUrl, sourceQuality: note.sourceQuality, scoreGradePlausible: note.scoreGradePlausible });
      expect(c?.scoreGradePlausible, id).toBe(id === "usdo-openeden");
    }
  });

  it("keeps missing-curation queues separate, complete and null-safe", () => {
    const miss = [
      coin({ id: "absent", reserves: undefined }), coin({ id: "empty", reserves: [] }), coin({ id: "configured", reserves: undefined, liveReservesConfig: liveCfg("m0") }),
      coin({ id: "inalpha-nest", reserves: undefined }), coin({ id: "unknown-adapter", reserves: undefined, liveReservesConfig: { ...liveCfg("m0"), adapter: "unknown" as LiveReserveAdapterKey } }),
    ];
    const a = buildAudit({ trackedCoins: [...activeCoins, ...miss, coin({ id: "pre", status: "pre-launch" }), coin({ id: "frozen", status: "frozen" })], activeCoins: [...activeCoins, ...miss], stablecoins: scPay });
    expect(a.curatedOnlyActiveCandidates.map((r) => r.coinId)).toEqual(["plain", "usdo-openeden"]);
    expect(a.activeWithoutCuratedReserves.map((r) => r.coinId)).toEqual(miss.map((r) => r.id));
    expect(a.unconfiguredWithoutCuratedReserves.map((r) => r.coinId)).toEqual(["absent", "empty", "inalpha-nest"]);
    expect(a.activeWithoutCuratedReserves.every((r) => r.marketCapUsd === null)).toBe(true);
    expect(a.activeWithoutCuratedReserves.find((r) => r.coinId === "configured")?.effectiveLiveAdapter).toBe("m0");
    expect(a.warnings.filter((w) => w.includes("unknown-adapter"))).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(a)).activeWithoutCuratedReserves).toHaveLength(5);
    const md = renderMd(a); for (const r of miss) expect(md).toContain(r.id);
    expect(a.activeWithoutCuratedReserves.find((r) => r.coinId === "inalpha-nest")?.scoreGradePlausible).toBe(false);
  });

  it("does not mistake reviewed unknown composition for absent curation or clip missing-curation rows", () => {
    const miss = Array.from({ length: 60 }, (_, i) => coin({ id: `no-curation-${i}`, reserves: undefined }));
    const unk = coin({ id: "unknown", reserves: [{ name: "Unknown reserve composition", pct: 100, risk: "high" }] });
    const a = buildAudit({ trackedCoins: [...miss, unk], activeCoins: [...miss, unk] });
    expect(a.activeWithoutCuratedReserves).toHaveLength(60); expect(a.curatedOnlyActiveCandidates.map((r) => r.coinId)).toEqual(["unknown"]);
    expect(renderMd(a)).toContain("no-curation-59");
  });

  it("audits backing provenance, proof scope, and custody consistency", () => {
    const usdc = [{ name: "USDC", pct: 100, risk: "low" as const, coinId: "usdc-circle" }];
    const a = buildAudit({
      generatedAt: "2026-07-13T00:00:00.000Z",
      activeCoins: [
        coin({ id: "reviewed", symbol: "REV", custodyModel: "institutional-top", reserves: [{ name: "Other reserve portfolio", pct: 100, risk: "medium", assetClass: "other", riskFactors: ["credit", "liquidity"] }], reserveReview: rev({ reviewedAt: "2025-01-01", confidence: "manual-review", compositionAsOf: "2025-06-01", knownUnknownExposure: "The portfolio constituents are undisclosed.", knownUnknownExposurePct: 100, nonLinkDispositions: [{ reserveIndex: 0, reserveName: "Other reserve portfolio", pct: 100, disposition: "basket-needs-split", rationale: "No constituent split is available." }] }), proofOfReserves: { type: "independent-audit", url: "https://example.com/proof", cadence: "monthly" } }),
        coin({ id: "profiled", symbol: "PRO", custodyModel: "onchain", reserves: usdc, reserveReview: noUnk, proofOfReserves: { type: "independent-audit", url: "https://example.com/proof", cadence: "monthly", latestReport: { periodEnd: "2026-05-31", publishedAt: "2026-06-20", assuranceMethod: "examination", scope: "assets-and-liabilities", liabilityReconciliation: "full", reviewer: "Fixture reviewer", confidence: "verified", sources: [{ label: "Report", url: "https://example.com/report" }] } }, custodyProfile: { providers: [{ name: "Fixture Bank", role: "bank" }], segregation: "segregated", bankruptcyRemoteness: "contractual-only", rehypothecation: "unknown", reviewedAt: "2026-07-01", reviewer: "Fixture reviewer", confidence: "verified", sources: [{ label: "Custody", url: "https://example.com/custody" }], uncertainty: "Provider shares are not disclosed." } }),
        coin({ id: "aup", symbol: "AUP", reserves: usdc, reserveReview: noUnk, proofOfReserves: { type: "agreed-upon-procedures", url: "https://example.com/proof", cadence: "monthly" } }),
        coin({ id: "attested", symbol: "ATT", reserves: usdc, reserveReview: noUnk, proofOfReserves: { type: "attestation", url: "https://example.com/proof", cadence: "monthly" } }),
      ],
    });
    expect(a.summary).toMatchObject({ activeStructuredReserveSliceCount: 1, activeWithReserveReviewCount: 4, activeMissingReserveReviewCount: 0, activeStaleReserveReviewCount: 1, activeStaleCompositionCount: 1, activeMaterialUnknownExposureCount: 1, activeOpaqueReserveSliceCount: 1, activeIndependentAuditCount: 2, activeIndependentAuditMissingLatestReportCount: 1, activeAgreedUponProceduresCount: 1, activeAgreedUponProceduresMissingLatestReportCount: 1, activeAttestationCount: 1, activeAttestationMissingLatestReportCount: 1, activeWithLatestProofReportCount: 1, activeLatestProofAssetsAndLiabilitiesCount: 1, activeExplicitCustodyModelCount: 2, activeWithCustodyProfileCount: 1, activeMissingCustodyProfileCount: 1, activeCustodyConsistencyWarningCount: 1 });
    expect(a.opaqueReserveSlices[0]).toMatchObject({ coinId: "reviewed", disposition: "basket-needs-split" });
    expect(a.independentAuditMissingLatestReport.map((r) => r.coinId)).toEqual(["reviewed"]);
    expect(a.agreedUponProceduresMissingLatestReport.map((r) => r.coinId)).toEqual(["aup"]);
    expect(a.attestationMissingLatestReport.map((r) => r.coinId)).toEqual(["attested"]);
  });

  it("treats an absent backingFromLiveReserves field as unavailable", () => {
    const a = buildAudit({ activeCoins, reportCards: { cards: activeCoins.map((e) => ({ id: e.id })) }, generatedAt: "2026-06-03T00:00:00.000Z" });
    expect([a.summary.backingFromLiveReservesActiveCount, a.summary.independentConfiguredButNotScoreGradeCount, a.independentConfiguredButNotScoreGradeIds]).toEqual([null, null, null]);
    expect(renderMd(a)).toContain("_backingFromLiveReserves unavailable in one or more active report cards._");
  });

  it("rejects empty report-card input while preserving static mode", () => {
    expect(() => buildAudit({ activeCoins, reportCards: { cards: [] } })).toThrow("Report-card input must contain at least one card.");
    expect(() => buildAudit({ activeCoins })).not.toThrow();
  });

  it("rolls up per-adapter prod sync status and score-grade from reserve states", () => {
    const a = buildAudit({
      activeCoins: [
        coin({ id: "live-a", symbol: "LIVA", reserves: [{ name: "USDC", pct: 100, risk: "low", coinId: "usdc-circle" }], liveReservesConfig: liveCfg("accountable") }),
        coin({ id: "live-b", symbol: "LIVB", reserves: [{ name: "Cash", pct: 100, risk: "low" }], liveReservesConfig: liveCfg("accountable") }),
        coin({ id: "live-c", symbol: "LIVC", reserves: [{ name: "Cash", pct: 100, risk: "low" }], liveReservesConfig: liveCfg("chainlink-nav") }),
      ],
      reserveStates: [
        { stablecoinId: "live-a", sync: { status: "ok" }, provenance: { scoringEligible: true, freshnessMode: "verified" } },
        { stablecoinId: "live-b", sync: { status: "degraded" }, provenance: { scoringEligible: false, freshnessMode: "unverified" } },
        { stablecoinId: "live-c", sync: { status: "error" }, provenance: { scoringEligible: false, freshnessMode: "not-applicable" } },
      ],
      generatedAt: "2026-06-03T00:00:00.000Z",
    });
    expect(a.reserveStatesSupplied).toBe(true);
    expect(a.adapterReliability).toEqual([
      { adapter: "accountable", boundCoinCount: 2, syncOk: 1, syncDegraded: 1, syncError: 0, syncSkippedOrUnknown: 0, scoreGradeCount: 1 },
      { adapter: "chainlink-nav", boundCoinCount: 1, syncOk: 0, syncDegraded: 0, syncError: 1, syncSkippedOrUnknown: 0, scoreGradeCount: 0 },
    ]);
    const md = renderMd(a);
    for (const s of ["## Adapter Reliability (--prod)", "adapter | bound coins | sync ok | degraded | error | skipped/unknown | score-grade", "accountable", "chainlink-nav"]) expect(md).toContain(s);
  });

  it("extracts reserve states from stablecoin-reserves-shaped entries", () => {
    expect(extractRows([{ stablecoinId: "a", sync: { status: "ok" }, provenance: { scoringEligible: true, freshnessMode: "verified" } }, { stablecoinId: "b", sync: { status: "skipped" }, provenance: { scoringEligible: false } }, { stablecoinId: "c" }, "not-an-object"])).toEqual([
      { id: "a", syncStatus: "ok", scoringEligible: true, freshnessMode: "verified" },
      { id: "b", syncStatus: "skipped", scoringEligible: false, freshnessMode: null },
      { id: "c", syncStatus: null, scoringEligible: null, freshnessMode: null },
    ]);
  });

  it.each(["ok", "degraded", "error", "skipped"])("retains admitted reserve status %s", (status) => {
    expect(extractRows({ reserves: [{ id: "coin", sync: { status } }] })).toEqual([{ id: "coin", syncStatus: status, scoringEligible: null, freshnessMode: null }]);
  });

  it.each([null, undefined, "", "running", "skipped_locked", 0, {}, ["ok"]])("retains unknown reserve status %j as unavailable", (status) => {
    expect(extractRows([{ id: "coin", sync: { status } }])).toEqual([{ id: "coin", syncStatus: null, scoringEligible: null, freshnessMode: null }]);
  });

  it("keeps the tGBP and USDXL suspensions non-executable and due at their own review boundary", () => {
    const ids = ["tgbp-tokenised", "usdxl-last"];
    const dormAt = (generatedAt: string) => new Map(buildAudit({ generatedAt }).configCensus.dormantConfigs.filter((r) => ids.includes(r.coinId)).map((r) => [r.coinId, r]));
    const rows = dormAt("2026-11-21T00:00:00.000Z");
    expect([...rows.keys()].sort()).toEqual([...ids].sort());
    for (const id of ids) {
      const r = rows.get(id)!;
      expect(r, id).toMatchObject({ status: "active", reviewDue: true }); expect(r.reviewBy, id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.suspensionReason, id).toBeTruthy(); expect(ACTIVE_META_BY_ID.get(id)?.liveReservesConfig, id).toBeUndefined();
      const b = Date.parse(`${r.reviewBy}T00:00:00Z`);
      expect(dormAt(new Date(b - 1).toISOString()).get(id)?.reviewDue, id).toBe(false);
      expect(dormAt(new Date(b).toISOString()).get(id)?.reviewDue, id).toBe(true);
    }
  });
});
