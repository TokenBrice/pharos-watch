import { describe, expect, it, vi } from "vitest";
import type { LiveReserveAdapterKey, LiveReservesConfig } from "@shared/types/live-reserves";
import type { StablecoinMeta } from "@shared/types";
import { makeCoverageCoin as coin } from "./helpers/coverage-coin";
import {
  REVIEWED_LIVE_RESERVE_SOURCE_NOTES,
  buildReserveCoverageAudit,
  parseArgs,
  renderReserveCoverageAuditMarkdown,
  runCli,
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
    id: "busd0-usual",
    symbol: "bUSD0",
    name: "Bond USD0",
    reserves: [{ name: "Locked USD0", pct: 100, risk: "low", coinId: "usd0-usual", depType: "wrapper" }],
  }),
] satisfies StablecoinMeta[];

const stablecoinsPayload = {
  peggedAssets: [
    { id: "plain", circulating: { peggedUSD: 20_000_000 } },
    { id: "busd0-usual", circulating: { peggedUSD: 10_000_000 } },
  ],
};

describe("generate-reserve-coverage-audit", () => {
  it("counts reserve coverage, evidence buckets, and score-grade gaps", () => {
    const audit = buildReserveCoverageAudit({
      trackedCoins: [...activeCoins, coin({ id: "pre" }), coin({ id: "frozen" })],
      activeCoins,
      preLaunchCoins: [coin({ id: "pre" })],
      frozenCoins: [coin({ id: "frozen" })],
      reportCards: {
        cards: [
          { id: "live-a", backingFromLiveReserves: true },
          { id: "live-b", backingFromLiveReserves: false },
          { id: "live-c", backingFromLiveReserves: false },
          { id: "plain", backingFromLiveReserves: false },
          { id: "busd0-usual", backingFromLiveReserves: false },
          { id: "defunct", isDefunct: true, backingFromLiveReserves: true },
        ],
      },
      stablecoins: stablecoinsPayload,
      generatedAt: "2026-06-03T00:00:00.000Z",
    });

    expect(audit.summary).toMatchObject({
      trackedCount: 7,
      activeCount: 5,
      preLaunchCount: 1,
      frozenCount: 1,
      activeWithCuratedReserves: 5,
      activeReserveSliceCount: 7,
      activeLinkedReserveSliceCount: 3,
      activeUnlinkedReserveSliceCount: 4,
      activeUnlinkedReserveSlicePctGte10Count: 3,
      activeUnlinkedReserveSlicePctGte50Count: 2,
      activeWithLinkedReserveSliceCount: 3,
      activeStructuredReserveSliceCount: 0,
      activeWithReserveReviewCount: 0,
      activeMissingReserveReviewCount: 5,
      activeOpaqueReserveSliceCount: 0,
      liveEnabledActiveCount: 3,
      curatedOnlyActiveCount: 2,
      curatedOnlyCandidateRankSource: "stablecoin-api-market-cap",
      reportCardActiveCount: 5,
      backingFromLiveReservesActiveCount: 1,
      dependencyFromLiveActiveCount: null,
      independentConfiguredButNotScoreGradeCount: 0,
    });
    expect(audit.liveEnabledByEvidenceClass).toEqual({
      independent: 1,
      "static-validated": 1,
      "weak-live-probe": 1,
    });
    expect(audit.independentConfiguredButNotScoreGradeIds).toEqual([]);
    expect(audit.curatedOnlyActiveCandidates.map((row) => row.coinId)).toEqual(["plain", "busd0-usual"]);
    expect(audit.curatedOnlyActiveCandidates.find((row) => row.coinId === "busd0-usual")).toMatchObject({
      sourceQuality: "independent",
      scoreGradePlausible: true,
    });
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
          reserveReview: {
            reviewedAt: "2026-07-01",
            reviewer: "Fixture reviewer",
            confidence: "verified",
            sources: [{ label: "Review", url: "https://example.com/review" }],
            rationale: "Fixture review rationale",
            compositionBasis: "Fixture disclosure",
            compositionAsOf: "2026-07-01",
            scope: "full-composition",
            knownUnknownExposure: "No material known unknown exposure.",
            knownUnknownExposurePct: 0,
          },
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
          reserveReview: {
            reviewedAt: "2026-07-01",
            reviewer: "Fixture reviewer",
            confidence: "verified",
            sources: [{ label: "Review", url: "https://example.com/review" }],
            rationale: "Fixture review rationale",
            compositionBasis: "Fixture disclosure",
            compositionAsOf: "2026-07-01",
            scope: "full-composition",
            knownUnknownExposure: "No material known unknown exposure.",
            knownUnknownExposurePct: 0,
          },
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
          reserveReview: {
            reviewedAt: "2026-07-01",
            reviewer: "Fixture reviewer",
            confidence: "verified",
            sources: [{ label: "Review", url: "https://example.com/review" }],
            rationale: "Fixture review rationale",
            compositionBasis: "Fixture disclosure",
            compositionAsOf: "2026-07-01",
            scope: "full-composition",
            knownUnknownExposure: "No material known unknown exposure.",
            knownUnknownExposurePct: 0,
          },
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

  it("renders missing score-grade independent configs when report cards are supplied", () => {
    const audit = buildReserveCoverageAudit({
      activeCoins,
      reportCards: { cards: activeCoins.map((entry) => ({ id: entry.id, backingFromLiveReserves: false })) },
      generatedAt: "2026-06-03T00:00:00.000Z",
    });

    expect(audit.independentConfiguredButNotScoreGradeIds).toEqual(["live-a"]);

    const markdown = renderReserveCoverageAuditMarkdown(audit);
    expect(markdown).toContain("# Reserve Coverage Audit");
    expect(markdown).toContain("- Live-enabled independent: 1");
    expect(markdown).toContain("- live-a");
    expect(markdown).toContain("## Highest-Market-Cap Curated-Only Active Candidates");
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

  it("warns when a reviewed source-quality note no longer matches an active stablecoin", () => {
    // busd0-usual is in activeCoins, so its note is in sync; every other
    // table key is stale relative to this synthetic active list.
    const audit = buildReserveCoverageAudit({
      activeCoins,
      generatedAt: "2026-06-03T00:00:00.000Z",
    });

    const staleKeys = Object.keys(REVIEWED_LIVE_RESERVE_SOURCE_NOTES).filter((id) => id !== "busd0-usual");
    expect(staleKeys.length).toBeGreaterThan(0);
    for (const id of staleKeys) {
      expect(audit.warnings).toContain(
        `Reviewed reserve source-quality note for "${id}" no longer matches any active stablecoin.`,
      );
    }
    // The in-sync key must not produce a stale warning.
    expect(audit.warnings).not.toContain(
      'Reviewed reserve source-quality note for "busd0-usual" no longer matches any active stablecoin.',
    );
  });

  it("parses CLI options", () => {
    expect(
      parseArgs([
        "--report-cards",
        "agents/report-cards.json",
        "--stablecoins",
        "agents/stablecoins.json",
        "--json",
        "--report",
        "agents/reserve-coverage.json",
        "--generated-at",
        "2026-06-03T00:00:00.000Z",
      ]),
    ).toMatchObject({
      reportCardsPath: "agents/report-cards.json",
      stablecoinsPath: "agents/stablecoins.json",
      format: "json",
      reportPath: "agents/reserve-coverage.json",
      generatedAt: "2026-06-03T00:00:00.000Z",
    });
    expect(() => parseArgs(["--prod", "--api-base", "https://api.example.test"])).toThrow(
      "Choose only one of --prod or --api-base.",
    );
    expect(() => parseArgs(["--prod", "--stablecoins", "agents/stablecoins.json"])).toThrow(
      "Choose fetched reserve coverage inputs or local input files, not both.",
    );
  });

  it("sends site-origin headers when fetching prod site-data", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      return new Response(JSON.stringify(href.includes("report-cards") ? { cards: [] } : { peggedAssets: [] }), {
        status: 200,
      });
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await expect(
        runCli(
          ["--prod", "--json", "--generated-at", "2026-06-03T00:00:00.000Z"],
          process.cwd(),
          fetchMock as unknown as typeof fetch,
        ),
      ).rejects.toThrow("Report-card input must contain at least one card.");
    } finally {
      stdout.mockRestore();
    }

    expect(fetchMock).toHaveBeenCalledWith(
      "https://pharos.watch/_site-data/report-cards/v9",
      expect.objectContaining({
        headers: expect.objectContaining({
          Origin: "https://pharos.watch",
          Referer: "https://pharos.watch/coverage/",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://pharos.watch/_site-data/stablecoins",
      expect.objectContaining({
        headers: expect.objectContaining({
          Origin: "https://pharos.watch",
          Referer: "https://pharos.watch/coverage/",
        }),
      }),
    );
  });
});
