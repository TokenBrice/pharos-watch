import { describe, expect, it } from "vitest";
import type { LiveReserveAdapterKey, LiveReservesConfig } from "@shared/types/live-reserves";
import type { StablecoinMeta } from "@shared/types";
import { ACTIVE_STABLECOINS, ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { makeCoverageCoin as coin } from "./helpers/coverage-coin";
import { reviewedReserve } from "./generate-reserve-coverage-audit.test-support";
import {
  REVIEWED_LIVE_RESERVE_SOURCE_NOTES,
  buildReserveCoverageAudit,
  extractReserveStateRows,
  renderReserveCoverageAuditMarkdown,
} from "../maintenance/generate-reserve-coverage-audit";

function liveConfig(adapter: LiveReserveAdapterKey): LiveReservesConfig {
  return {
    adapter,
    version: 1,
    semantics: "collateral-mix",
    display: { url: `https://example.com/${adapter}` },
    inputs: {
      primary: { kind: "http-json", url: `https://example.com/${adapter}.json` },
    },
    params: {},
  };
}

const activeCoins = [
  coin({
    id: "live-a",
    symbol: "LIVA",
    reserves: [
      { name: "USDC", pct: 60, risk: "low", coinId: "usdc-circle" },
      { name: "Cash", pct: 40, risk: "very-low" },
    ],
    liveReservesConfig: liveConfig("accountable"),
  }),
  coin({
    id: "live-b",
    symbol: "LIVB",
    reserves: [
      { name: "Treasuries", pct: 55, risk: "very-low" },
      { name: "Stablecoin basket", pct: 9, risk: "low" },
    ],
    liveReservesConfig: liveConfig("curated-validated"),
  }),
  coin({
    id: "live-c",
    symbol: "LIVC",
    reserves: [{ name: "Single token", pct: 100, risk: "low", coinId: "usdt-tether" }],
    liveReservesConfig: liveConfig("single-asset"),
  }),
  coin({ id: "plain", symbol: "PLN", name: "Plain Coin", reserves: [{ name: "Cash", pct: 100, risk: "very-low" }] }),
  coin({
    id: "usdo-openeden",
    symbol: "USDO",
    name: "OpenEden USDO",
    reserves: [{ name: "US Treasuries", pct: 100, risk: "low", coinId: "usdc-circle" }],
  }),
] satisfies StablecoinMeta[];

const stablecoinsPayload = {
  peggedAssets: [
    { id: "plain", circulating: { peggedUSD: 20_000_000 } },
    { id: "usdo-openeden", circulating: { peggedUSD: 10_000_000 } },
  ],
};

describe("generate-reserve-coverage-audit", () => {
  it("keeps source-quality dispositions on active effective-unconfigured assets and propagates their evidence", () => {
    const audit = buildReserveCoverageAudit({ activeCoins: ACTIVE_STABLECOINS });
    const candidates = [...audit.curatedOnlyActiveCandidates, ...audit.unconfiguredWithoutCuratedReserves];
    for (const [id, note] of Object.entries(REVIEWED_LIVE_RESERVE_SOURCE_NOTES)) {
      const meta = ACTIVE_META_BY_ID.get(id);
      expect(meta, id).toBeDefined();
      expect(meta?.liveReservesConfig, id).toBeUndefined();
      const candidate = candidates.find((row) => row.coinId === id);
      expect(candidate, id).toMatchObject({
        sourceUrl: note.sourceUrl, sourceQuality: note.sourceQuality,
        scoreGradePlausible: note.scoreGradePlausible,
      });
      expect(candidate?.scoreGradePlausible, id).toBe(id === "usdo-openeden");
    }
  });

  it("keeps missing-curation queues separate, complete and null-safe", () => {
    const missing = [
      coin({ id: "absent", reserves: undefined }),
      coin({ id: "empty", reserves: [] }),
      coin({ id: "configured", reserves: undefined, liveReservesConfig: liveConfig("m0") }),
      coin({ id: "inalpha-nest", reserves: undefined }),
      coin({ id: "unknown-adapter", reserves: undefined, liveReservesConfig: { ...liveConfig("m0"), adapter: "unknown" as LiveReserveAdapterKey } }),
    ];
    const audit = buildReserveCoverageAudit({
      trackedCoins: [...activeCoins, ...missing, coin({ id: "pre", status: "pre-launch" }), coin({ id: "frozen", status: "frozen" })],
      activeCoins: [...activeCoins, ...missing], stablecoins: stablecoinsPayload,
    });
    expect(audit.curatedOnlyActiveCandidates.map((row) => row.coinId)).toEqual(["plain", "usdo-openeden"]);
    expect(audit.activeWithoutCuratedReserves.map((row) => row.coinId)).toEqual(missing.map((row) => row.id));
    expect(audit.unconfiguredWithoutCuratedReserves.map((row) => row.coinId)).toEqual(["absent", "empty", "inalpha-nest"]);
    expect(audit.activeWithoutCuratedReserves.every((row) => row.marketCapUsd === null)).toBe(true);
    expect(audit.activeWithoutCuratedReserves.find((row) => row.coinId === "configured")?.effectiveLiveAdapter).toBe("m0");
    expect(audit.warnings.filter((warning) => warning.includes("unknown-adapter"))).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(audit)).activeWithoutCuratedReserves).toHaveLength(5);
    const markdown = renderReserveCoverageAuditMarkdown(audit);
    for (const row of missing) expect(markdown).toContain(row.id);
    expect(audit.activeWithoutCuratedReserves.find((row) => row.coinId === "inalpha-nest")?.scoreGradePlausible).toBe(false);
  });

  it("does not mistake reviewed unknown composition for absent curation or clip missing-curation rows", () => {
    const missing = Array.from({ length: 60 }, (_, index) => coin({ id: `no-curation-${index}`, reserves: undefined }));
    const reviewedUnknown = coin({ id: "unknown", reserves: [{ name: "Unknown reserve composition", pct: 100, risk: "high" }] });
    const audit = buildReserveCoverageAudit({ trackedCoins: [...missing, reviewedUnknown], activeCoins: [...missing, reviewedUnknown] });
    expect(audit.activeWithoutCuratedReserves).toHaveLength(60);
    expect(audit.curatedOnlyActiveCandidates.map((row) => row.coinId)).toEqual(["unknown"]);
    expect(renderReserveCoverageAuditMarkdown(audit)).toContain("no-curation-59");
  });

  it("audits backing provenance, proof scope, and custody consistency", () => {
    const audit = buildReserveCoverageAudit({
      activeCoins: [
        coin({
          id: "reviewed",
          symbol: "REV",
          custodyModel: "institutional-top",
          reserves: [
            {
              name: "Other reserve portfolio",
              pct: 100,
              risk: "medium",
              assetClass: "other",
              riskFactors: ["credit", "liquidity"],
            },
          ],
          reserveReview: {
            reviewedAt: "2025-01-01",
            reviewer: "Fixture reviewer",
            confidence: "manual-review",
            sources: [{ label: "Review", url: "https://example.com/review" }],
            rationale: "Fixture review rationale",
            compositionBasis: "Fixture disclosure",
            compositionAsOf: "2025-06-01",
            scope: "full-composition",
            knownUnknownExposure: "The portfolio constituents are undisclosed.",
            knownUnknownExposurePct: 100,
            nonLinkDispositions: [
              {
                reserveIndex: 0,
                reserveName: "Other reserve portfolio",
                pct: 100,
                disposition: "basket-needs-split",
                rationale: "No constituent split is available.",
              },
            ],
          },
          proofOfReserves: {
            type: "independent-audit",
            url: "https://example.com/proof",
            cadence: "monthly",
          },
        }),
        coin({
          id: "profiled",
          symbol: "PRO",
          custodyModel: "onchain",
          reserves: [{ name: "USDC", pct: 100, risk: "low", coinId: "usdc-circle" }],
          reserveReview: reviewedReserve({
            knownUnknownExposure: "No material known unknown exposure.",
            knownUnknownExposurePct: 0,
          }),
          proofOfReserves: {
            type: "independent-audit",
            url: "https://example.com/proof",
            cadence: "monthly",
            latestReport: {
              periodEnd: "2026-05-31",
              publishedAt: "2026-06-20",
              assuranceMethod: "examination",
              scope: "assets-and-liabilities",
              liabilityReconciliation: "full",
              reviewer: "Fixture reviewer",
              confidence: "verified",
              sources: [{ label: "Report", url: "https://example.com/report" }],
            },
          },
          custodyProfile: {
            providers: [{ name: "Fixture Bank", role: "bank" }],
            segregation: "segregated",
            bankruptcyRemoteness: "contractual-only",
            rehypothecation: "unknown",
            reviewedAt: "2026-07-01",
            reviewer: "Fixture reviewer",
            confidence: "verified",
            sources: [{ label: "Custody", url: "https://example.com/custody" }],
            uncertainty: "Provider shares are not disclosed.",
          },
        }),
        coin({
          id: "aup",
          symbol: "AUP",
          reserves: [{ name: "USDC", pct: 100, risk: "low", coinId: "usdc-circle" }],
          reserveReview: reviewedReserve({
            knownUnknownExposure: "No material known unknown exposure.",
            knownUnknownExposurePct: 0,
          }),
          proofOfReserves: {
            type: "agreed-upon-procedures",
            url: "https://example.com/proof",
            cadence: "monthly",
          },
        }),
        coin({
          id: "attested",
          symbol: "ATT",
          reserves: [{ name: "USDC", pct: 100, risk: "low", coinId: "usdc-circle" }],
          reserveReview: reviewedReserve({
            knownUnknownExposure: "No material known unknown exposure.",
            knownUnknownExposurePct: 0,
          }),
          proofOfReserves: {
            type: "attestation",
            url: "https://example.com/proof",
            cadence: "monthly",
          },
        }),
      ],
      generatedAt: "2026-07-13T00:00:00.000Z",
    });

    expect(audit.summary).toMatchObject({
      activeStructuredReserveSliceCount: 1,
      activeWithReserveReviewCount: 4,
      activeMissingReserveReviewCount: 0,
      activeStaleReserveReviewCount: 1,
      activeStaleCompositionCount: 1,
      activeMaterialUnknownExposureCount: 1,
      activeOpaqueReserveSliceCount: 1,
      activeIndependentAuditCount: 2,
      activeIndependentAuditMissingLatestReportCount: 1,
      activeAgreedUponProceduresCount: 1,
      activeAgreedUponProceduresMissingLatestReportCount: 1,
      activeAttestationCount: 1,
      activeAttestationMissingLatestReportCount: 1,
      activeWithLatestProofReportCount: 1,
      activeLatestProofAssetsAndLiabilitiesCount: 1,
      activeExplicitCustodyModelCount: 2,
      activeWithCustodyProfileCount: 1,
      activeMissingCustodyProfileCount: 1,
      activeCustodyConsistencyWarningCount: 1,
    });
    expect(audit.opaqueReserveSlices[0]).toMatchObject({
      coinId: "reviewed",
      disposition: "basket-needs-split",
    });
    expect(audit.independentAuditMissingLatestReport.map((row) => row.coinId)).toEqual(["reviewed"]);
    expect(audit.agreedUponProceduresMissingLatestReport.map((row) => row.coinId)).toEqual(["aup"]);
    expect(audit.attestationMissingLatestReport.map((row) => row.coinId)).toEqual(["attested"]);
  });

  it("treats an absent backingFromLiveReserves field as unavailable", () => {
    const audit = buildReserveCoverageAudit({
      activeCoins,
      reportCards: { cards: activeCoins.map((entry) => ({ id: entry.id })) },
      generatedAt: "2026-06-03T00:00:00.000Z",
    });

    expect(audit.summary.backingFromLiveReservesActiveCount).toBeNull();
    expect(audit.summary.independentConfiguredButNotScoreGradeCount).toBeNull();
    expect(audit.independentConfiguredButNotScoreGradeIds).toBeNull();
    expect(renderReserveCoverageAuditMarkdown(audit)).toContain(
      "_backingFromLiveReserves unavailable in one or more active report cards._",
    );
  });

  it("rejects empty report-card input while preserving static mode", () => {
    expect(() => buildReserveCoverageAudit({ activeCoins, reportCards: { cards: [] } })).toThrow(
      "Report-card input must contain at least one card.",
    );
    expect(() => buildReserveCoverageAudit({ activeCoins })).not.toThrow();
  });

  it("rolls up per-adapter prod sync status and score-grade from reserve states", () => {
    const audit = buildReserveCoverageAudit({
      activeCoins: [
        coin({
          id: "live-a",
          symbol: "LIVA",
          reserves: [{ name: "USDC", pct: 100, risk: "low", coinId: "usdc-circle" }],
          liveReservesConfig: liveConfig("accountable"),
        }),
        coin({
          id: "live-b",
          symbol: "LIVB",
          reserves: [{ name: "Cash", pct: 100, risk: "low" }],
          liveReservesConfig: liveConfig("accountable"),
        }),
        coin({
          id: "live-c",
          symbol: "LIVC",
          reserves: [{ name: "Cash", pct: 100, risk: "low" }],
          liveReservesConfig: liveConfig("chainlink-nav"),
        }),
      ],
      reserveStates: [
        { stablecoinId: "live-a", sync: { status: "ok" }, provenance: { scoringEligible: true, freshnessMode: "verified" } },
        { stablecoinId: "live-b", sync: { status: "degraded" }, provenance: { scoringEligible: false, freshnessMode: "unverified" } },
        { stablecoinId: "live-c", sync: { status: "error" }, provenance: { scoringEligible: false, freshnessMode: "not-applicable" } },
      ],
      generatedAt: "2026-06-03T00:00:00.000Z",
    });

    expect(audit.reserveStatesSupplied).toBe(true);
    expect(audit.adapterReliability).toEqual([
      { adapter: "accountable", boundCoinCount: 2, syncOk: 1, syncDegraded: 1, syncError: 0, syncSkippedOrUnknown: 0, scoreGradeCount: 1 },
      { adapter: "chainlink-nav", boundCoinCount: 1, syncOk: 0, syncDegraded: 0, syncError: 1, syncSkippedOrUnknown: 0, scoreGradeCount: 0 },
    ]);

    const markdown = renderReserveCoverageAuditMarkdown(audit);
    expect(markdown).toContain("## Adapter Reliability (--prod)");
    expect(markdown).toContain("adapter | bound coins | sync ok | degraded | error | skipped/unknown | score-grade");
    expect(markdown).toContain("accountable");
    expect(markdown).toContain("chainlink-nav");
  });

  it("extracts reserve states from stablecoin-reserves-shaped entries", () => {
    expect(
      extractReserveStateRows([
        { stablecoinId: "a", sync: { status: "ok" }, provenance: { scoringEligible: true, freshnessMode: "verified" } },
        { stablecoinId: "b", sync: { status: "skipped" }, provenance: { scoringEligible: false } },
        { stablecoinId: "c" },
        "not-an-object",
      ]),
    ).toEqual([
      { id: "a", syncStatus: "ok", scoringEligible: true, freshnessMode: "verified" },
      { id: "b", syncStatus: "skipped", scoringEligible: false, freshnessMode: null },
      { id: "c", syncStatus: null, scoringEligible: null, freshnessMode: null },
    ]);
  });

  it.each(["ok", "degraded", "error", "skipped"])("retains admitted reserve status %s", (status) => {
    expect(extractReserveStateRows({ reserves: [{ id: "coin", sync: { status } }] })).toEqual([
      { id: "coin", syncStatus: status, scoringEligible: null, freshnessMode: null },
    ]);
  });
  it.each([null, undefined, "", "running", "skipped_locked", 0, {}, ["ok"]])(
    "retains unknown reserve status %j as unavailable", (status) => {
      expect(extractReserveStateRows([{ id: "coin", sync: { status } }])).toEqual([
        { id: "coin", syncStatus: null, scoringEligible: null, freshnessMode: null },
      ]);
    },
  );

  it("keeps the tGBP, USDXL and USDN suspensions non-executable and due from the November 20 UTC boundary", () => {
    const ids = ["tgbp-tokenised", "usdxl-last", "usdn-noble"];
    const dormantAt = (generatedAt: string) => new Map(
      buildReserveCoverageAudit({ generatedAt }).configCensus.dormantConfigs
        .filter((row) => ids.includes(row.coinId))
        .map((row) => [row.coinId, row]),
    );
    for (const [generatedAt, due] of [
      ["2026-11-19T23:59:59.999Z", false],
      ["2026-11-20T00:00:00.000Z", true],
      ["2026-11-21T00:00:00.000Z", true],
    ] as const) {
      const rows = dormantAt(generatedAt);
      expect([...rows.keys()].sort()).toEqual([...ids].sort());
      for (const id of ids) {
        expect(rows.get(id), `${id} at ${generatedAt}`).toMatchObject({ status: "active", reviewBy: "2026-11-20", reviewDue: due });
        expect(rows.get(id)?.suspensionReason).toBeTruthy();
        expect(ACTIVE_META_BY_ID.get(id)?.liveReservesConfig).toBeUndefined();
      }
    }
  });
});
