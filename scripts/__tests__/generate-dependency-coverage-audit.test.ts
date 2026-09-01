import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types";
import type { LiveReserveAdapterKey, LiveReservesConfig } from "@shared/types/live-reserves";
import { makeCoverageCoin as coin } from "./helpers/coverage-coin";
import {
  buildDependencyCoverageAudit,
  evaluateDependencyCoverageStructure,
  parseArgs,
  renderDependencyCoverageAuditMarkdown,
  runCli,
} from "../maintenance/generate-dependency-coverage-audit";

function liveConfig(adapter: LiveReserveAdapterKey): LiveReservesConfig {
  return {
    adapter,
    version: 1,
    semantics: "collateral-mix",
    inputs: { primary: { kind: "http-json", url: `https://example.test/${adapter}.json` } },
  };
}

const activeCoins: StablecoinMeta[] = [
  coin({ id: "usdc-circle", symbol: "USDC", name: "USD Coin" }),
  coin({ id: "usdt-tether", symbol: "USDT", name: "Tether USD" }),
  coin({
    id: "wrap-usdc",
    symbol: "wUSDC",
    reserves: [{ name: "USDC", pct: 100, risk: "low", coinId: "usdc-circle" }],
  }),
  coin({
    id: "manual-usdt",
    symbol: "mUSDT",
    dependencies: [{ id: "usdt-tether", weight: 0.5, type: "mechanism" }],
    dependencyReview: {
      reviewedAt: "2026-07-12",
      reviewer: "fixture reviewer",
      confidence: "verified",
      sources: [{ label: "Docs", url: "https://example.test/manual" }],
      rationale: "Fixture manual dependency review.",
      relationships: [{
        id: "usdt-tether",
        type: "mechanism",
        weight: 0.5,
        reason: "Fixture mechanism dependency.",
      }],
    },
  }),
  coin({
    id: "cash-only",
    symbol: "CASH",
    reserves: [
      { name: "Cash", pct: 90, risk: "very-low" },
      { name: "Stablecoin basket", pct: 10, risk: "low", depType: "mechanism" },
    ],
  }),
  coin({
    id: "lone-high",
    symbol: "LONE",
    name: "Lone High",
    contracts: [{ chain: "base", address: "0x0000000000000000000000000000000000000001", decimals: 18 }],
  }),
];

const stablecoinsPayload = {
  peggedAssets: [
    { id: "lone-high", circulating: { peggedUSD: 50_000_000 } },
    { id: "cash-only", circulating: { peggedUSD: 20_000_000 } },
    { id: "manual-usdt", circulating: { peggedUSD: 10_000_000 } },
    { id: "wrap-usdc", circulating: { peggedUSD: 5_000_000 } },
    { id: "usdt-tether", circulating: { peggedUSD: 4_000_000 } },
    { id: "usdc-circle", circulating: { peggedUSD: 3_000_000 } },
  ],
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

describe("generate-dependency-coverage-audit", () => {
  it("counts static graph coverage and reserve/dependency audit rows", () => {
    const audit = buildDependencyCoverageAudit({
      activeCoins,
      stablecoins: stablecoinsPayload,
      generatedAt: "2026-05-24T00:00:00.000Z",
    });

    expect(audit.summary).toMatchObject({
      activeCount: 6,
      staticEdgeCount: 2,
      staticActiveEdgeCount: 2,
      staticParticipantCount: 4,
      staticDependentCount: 2,
      staticUpstreamOnlyCount: 2,
      manualOnlyDependencyCount: 1,
      reserveSlicesMissingCoinId: 2,
      depTypeWithoutCoinIdWarnings: 1,
      staticSelfEdgeCount: 0,
      staticDuplicateEdgeCount: 0,
      staticStronglyConnectedComponentCount: 0,
      overweightEffectiveSetCount: 0,
      unknownTargetEdgeCount: 0,
      manualDependencyReviewGapCount: 0,
      missingCandidateCount: 2,
      l2beatDeploymentContextCount: 1,
      l2beatLayer3DeploymentContextCount: 0,
      l2beatUnderReviewDeploymentContextCount: 0,
      missingCandidateGraphSource: "static",
      missingCandidateRankSource: "stablecoin-api-market-cap",
    });
    expect(audit.manualOnlyDependencies).toEqual([
      {
        coinId: "manual-usdt",
        symbol: "mUSDT",
        dependencyId: "usdt-tether",
        dependencyType: "mechanism",
        weight: 0.5,
        reviewStatus: "reviewed",
      },
    ]);
    expect(audit.depTypeWithoutCoinIdWarnings).toEqual([
      expect.objectContaining({
        coinId: "cash-only",
        reserveIndex: 1,
        reserveName: "Stablecoin basket",
        depType: "mechanism",
      }),
    ]);
    expect(audit.highestMarketCapMissingCandidates.map((row) => row.coinId)).toEqual([
      "lone-high",
      "cash-only",
    ]);
    expect(audit.l2beatDeploymentContext).toEqual([
      expect.objectContaining({
        coinId: "lone-high",
        chainId: "base",
        projectId: "base",
        layer: "layer2",
        hostChain: "Ethereum",
      }),
    ]);
  });

  it("uses report-card graph input when ranking missing runtime candidates", () => {
    const audit = buildDependencyCoverageAudit({
      activeCoins,
      stablecoins: stablecoinsPayload,
      reportCards: {
        cards: [{ id: "wrap-usdc", overallScore: 70 }],
        dependencyGraph: {
          edges: [{ from: "usdc-circle", to: "wrap-usdc", weight: 1, type: "collateral" }],
        },
      },
    });

    expect(audit.summary).toMatchObject({
      reportCardEdgeCount: 1,
      reportCardParticipantCount: 2,
      reportCardDependentCount: 1,
      reportCardUpstreamOnlyCount: 1,
      missingCandidateGraphSource: "report-card",
      missingCandidateCount: 4,
    });
    expect(audit.highestMarketCapMissingCandidates.map((row) => row.coinId)).toEqual([
      "lone-high",
      "cash-only",
      "manual-usdt",
      "usdt-tether",
    ]);
  });

  it("accepts the current V9 report-v5 score and native dependency graph shape", () => {
    const audit = buildDependencyCoverageAudit({
      activeCoins: [
        coin({ id: "serial-upstream", symbol: "SER" }),
        coin({ id: "basket-upstream", symbol: "BSK" }),
        coin({ id: "dependent", symbol: "DEP" }),
      ],
      reportCards: {
        schemaVersion: 5,
        cards: [
          { id: "serial-upstream", score: 80 },
          { id: "basket-upstream", score: null },
          { id: "dependent", score: 65 },
        ],
        dependencyGraph: {
          edges: [
            {
              from: "serial-upstream",
              to: "dependent",
              kind: "serial",
              materiality: "serial",
              weight: null,
              upstreamScore: 80,
            },
            {
              from: "basket-upstream",
              to: "dependent",
              kind: "basket",
              materiality: "basket-weighted",
              weight: 0.25,
              upstreamScore: null,
            },
          ],
        },
      },
    });

    expect(audit.summary).toMatchObject({
      reportCardEdgeCount: 2,
      reportCardParticipantCount: 3,
      unavailableTargetEdgeCount: 1,
    });
    expect(audit.dependencyEdges).toEqual([
      expect.objectContaining({
        from: "basket-upstream",
        reportKind: "basket",
        reportMateriality: "basket-weighted",
        reportedWeight: 0.25,
        targetScoreability: "active-nr",
      }),
      expect.objectContaining({
        from: "serial-upstream",
        reportKind: "serial",
        reportMateriality: "serial",
        reportedWeight: null,
        targetScoreability: "scoreable",
      }),
    ]);
  });

  it("rejects malformed or duplicate report-card cards, dependencies, diagnostics, and edges", () => {
    const validEdge = { from: "upstream", to: "dependent", weight: 0.5, type: "collateral" };
    const validCard = { id: "dependent", overallScore: 70 };
    const payload = (cards: unknown, edges: unknown) => ({ cards, dependencyGraph: { edges } });
    const malformedCases: Array<{ label: string; value: unknown; path: string }> = [
      { label: "non-array cards", value: payload({}, []), path: "cards" },
      { label: "non-object card", value: payload([null], []), path: "cards[0]" },
      {
        label: "duplicate card IDs",
        value: payload([validCard, validCard], []),
        path: "duplicate card ID dependent",
      },
      {
        label: "invalid card score",
        value: payload([{ ...validCard, overallScore: "70" }], []),
        path: "cards[0].overallScore",
      },
      {
        label: "invalid dependency type",
        value: payload([{
          ...validCard,
          rawInputs: { dependencies: [{ id: "upstream", weight: 0.5, type: "unknown" }] },
        }], []),
        path: "cards[0].rawInputs.dependencies[0].type",
      },
      {
        label: "invalid dependency weight",
        value: payload([{
          ...validCard,
          rawInputs: { dependencies: [{ id: "upstream", weight: 0, type: "collateral" }] },
        }], []),
        path: "cards[0].rawInputs.dependencies[0].weight",
      },
      {
        label: "duplicate dependencies",
        value: payload([{
          ...validCard,
          rawInputs: {
            dependencies: [
              { id: "upstream", weight: 0.25 },
              { id: "upstream", weight: 0.5, type: "collateral" },
            ],
          },
        }], []),
        path: "duplicate dependency upstream::collateral",
      },
      {
        label: "invalid diagnostic contribution",
        value: payload([{
          ...validCard,
          dimensions: {
            dependencyRisk: {
              dependencyDiagnostics: {
                contributions: [{ id: "upstream", type: "collateral", available: "yes" }],
              },
            },
          },
        }], []),
        path: "contributions[0].available",
      },
      { label: "non-array edges", value: payload([validCard], {}), path: "dependencyGraph.edges" },
      { label: "non-object edge", value: payload([validCard], [null]), path: "dependencyGraph.edges[0]" },
      {
        label: "invalid edge type",
        value: payload([validCard], [{ ...validEdge, type: "unknown" }]),
        path: "dependencyGraph.edges[0].type",
      },
      {
        label: "invalid edge weight",
        value: payload([validCard], [{ ...validEdge, weight: 1.1 }]),
        path: "dependencyGraph.edges[0].weight",
      },
      {
        label: "duplicate edges",
        value: payload([validCard], [validEdge, { ...validEdge, weight: 0.25 }]),
        path: "duplicate dependency edge upstream->dependent::collateral",
      },
    ];

    for (const testCase of malformedCases) {
      expect(
        () => buildDependencyCoverageAudit({ activeCoins: [], reportCards: testCase.value }),
        testCase.label,
      ).toThrow(testCase.path);
    }
  });

  it("finds raw-suppressed self edges, effective duplicates, SCCs, authored repeats, and true overweight sets", () => {
    const defectCoins = [
      coin({ id: "self", dependencies: [{ id: "self", weight: 1, type: "collateral" }] }),
      coin({ id: "cycle-a", dependencies: [{ id: "cycle-b", weight: 1, type: "mechanism" }] }),
      coin({ id: "cycle-b", dependencies: [{ id: "cycle-a", weight: 1, type: "mechanism" }] }),
      coin({ id: "dup-target" }),
      coin({
        id: "duplicate",
        dependencies: [
          { id: "dup-target", weight: 0.25, type: "collateral" },
          { id: "dup-target", weight: 0.25, type: "collateral" },
        ],
      }),
      coin({ id: "target-a" }),
      coin({ id: "target-b" }),
      coin({
        id: "overweight",
        dependencies: [
          { id: "target-a", weight: 0.7, type: "collateral" },
          { id: "target-b", weight: 0.4, type: "mechanism" },
        ],
      }),
      coin({
        id: "floating-one",
        dependencies: [
          { id: "target-a", weight: 0.1, type: "collateral" },
          { id: "target-b", weight: 0.2, type: "mechanism" },
          { id: "dup-target", weight: 0.7, type: "wrapper" },
        ],
      }),
      coin({
        id: "split-reserve",
        reserves: [
          { name: "Route one", pct: 40, risk: "low", coinId: "target-a" },
          { name: "Route two", pct: 30, risk: "medium", coinId: "target-a" },
        ],
      }),
    ];
    const audit = buildDependencyCoverageAudit({ activeCoins: defectCoins });

    expect(audit.summary).toMatchObject({
      staticSelfEdgeCount: 1,
      staticDuplicateEdgeCount: 1,
      staticStronglyConnectedComponentCount: 1,
      rawAuthoredDuplicateCount: 2,
      overweightEffectiveSetCount: 1,
    });
    expect(audit.staticGraphDiagnostics.stronglyConnectedComponents).toEqual([["cycle-a", "cycle-b"]]);
    expect(audit.rawAuthoredDuplicates).toEqual(expect.arrayContaining([
      expect.objectContaining({ coinId: "duplicate", source: "dependencies", indices: [0, 1] }),
      expect.objectContaining({ coinId: "split-reserve", source: "reserves", indices: [0, 1] }),
    ]));
    expect(audit.overweightEffectiveSets.map((row) => row.coinId)).toEqual(["overweight"]);
  });

  it("reports runtime lifecycle, scoreability, P1b provenance, availability, and adapter review", () => {
    const runtimeCoins = [
      coin({ id: "scoreable", symbol: "GOOD" }),
      coin({ id: "active-nr", symbol: "NR" }),
      coin({ id: "dependent", symbol: "DEP", liveReservesConfig: liveConfig("accountable") }),
      coin({ id: "legacy", symbol: "LEG" }),
    ];
    const trackedCoins = [
      ...runtimeCoins,
      coin({ id: "prelaunch", symbol: "PRE", status: "pre-launch" }),
      coin({ id: "frozen", symbol: "FRZ", status: "frozen" }),
    ];
    const reportCards = {
      cards: [
        { id: "scoreable", overallScore: 82 },
        { id: "active-nr", overallScore: null },
        {
          id: "dependent",
          overallScore: 70,
          rawInputs: {
            dependencies: [
              { id: "scoreable", weight: 0.5, type: "collateral" },
              { id: "active-nr", weight: 0.2, type: "mechanism" },
            ],
            dependencySource: "live-reserve",
            dependencyBaseSource: "live-reserve",
            dependencyFromLive: true,
            mappedLiveReserveWeight: 0.7,
            dependencyFallbackReason: null,
          },
          dimensions: {
            dependencyRisk: {
              dependencyDiagnostics: {
                availableWeight: 0.5,
                unavailableWeight: 0.2,
                contributions: [
                  { id: "scoreable", type: "collateral", available: true },
                  { id: "active-nr", type: "mechanism", available: false },
                ],
              },
            },
          },
        },
        { id: "legacy", overallScore: 60, rawInputs: {}, dimensions: { dependencyRisk: {} } },
      ],
      dependencyGraph: {
        edges: [
          { from: "scoreable", to: "dependent", weight: 0.5, type: "collateral" },
          { from: "active-nr", to: "dependent", weight: 0.2, type: "mechanism" },
          { from: "prelaunch", to: "dependent", weight: 0.1, type: "collateral" },
          { from: "frozen", to: "dependent", weight: 0.1, type: "collateral" },
          { from: "missing", to: "dependent", weight: 0.1, type: "collateral" },
        ],
      },
    };
    const targetDispositions = [
      {
        targetId: "active-nr",
        expectedLifecycle: "active" as const,
        action: "retain-reviewed-link" as const,
        reviewer: "reviewer",
        reviewedAt: "2026-07-12",
        sources: [{ label: "Docs", url: "https://example.test/nr" }],
        rationale: "The upstream is active but its current report card is NR.",
      },
      {
        targetId: "prelaunch",
        expectedLifecycle: "pre-launch" as const,
        action: "retain-reviewed-link" as const,
        reviewer: "reviewer",
        reviewedAt: "2026-07-12",
        sources: [{ label: "Docs", url: "https://example.test/pre" }],
        rationale: "The pre-launch upstream relationship is evidenced.",
      },
      {
        targetId: "frozen",
        expectedLifecycle: "frozen" as const,
        action: "retain-reviewed-link" as const,
        reviewer: "reviewer",
        reviewedAt: "2026-07-12",
        sources: [{ label: "Docs", url: "https://example.test/frozen" }],
        rationale: "The frozen upstream relationship remains historically correct.",
      },
    ];
    const adapterMappingReviews = [{
      adapter: "accountable",
      reviewer: "reviewer",
      reviewedAt: "2026-07-12",
      sourceFiles: ["worker/src/cron/reserve-adapters/accountable.ts"],
      rationale: "Fixture adapter mapping review.",
    }];
    const audit = buildDependencyCoverageAudit({
      activeCoins: runtimeCoins,
      trackedCoins,
      reportCards,
      targetDispositions,
      adapterMappingReviews,
    });

    expect(audit.dependencyEdges.map((row) => [row.from, row.targetLifecycle, row.targetScoreability])).toEqual([
      ["active-nr", "active", "active-nr"],
      ["frozen", "frozen", "frozen"],
      ["missing", "unknown", "unknown-target"],
      ["prelaunch", "pre-launch", "pre-launch"],
      ["scoreable", "active", "scoreable"],
    ]);
    expect(audit.dependencyProvenance.find((row) => row.coinId === "dependent")).toMatchObject({
      source: "live-reserve",
      baseSource: "live-reserve",
      availableWeight: 0.5,
      unavailableWeight: 0.2,
      mappedLiveReserveShare: 0.7,
      unmappedLiveReserveShare: 0.30000000000000004,
    });
    expect(audit.dependencyProvenance.find((row) => row.coinId === "legacy")).toMatchObject({
      source: null,
      availableWeight: null,
      mappedLiveReserveShare: null,
    });
    expect(audit.adapterMappingReviewGaps).toEqual([]);
    expect(audit.summary).toMatchObject({
      unknownTargetEdgeCount: 1,
      unavailableTargetEdgeCount: 4,
      unavailableTargetDispositionGapCount: 1,
      adapterMappingReviewGapCount: 0,
    });
  });

  it("uses delimiter matchers, preserves ambiguous candidates, excludes generic symbols, and validates reserve dispositions", () => {
    const subject = coin({
      id: "subject",
      symbol: "SUB",
      reserves: [
        { name: "USDC vault", pct: 20, risk: "low" },
        { name: "CASH reserve", pct: 20, risk: "very-low" },
        { name: "MUSDCX strategy", pct: 15, risk: "medium" },
        { name: "Stablecoin basket", pct: 15, risk: "low" },
        { name: "External CDP position", pct: 10, risk: "medium" },
        { name: "Mystery dependency", pct: 10, risk: "high", depType: "mechanism" },
        { name: "USDC changed slice", pct: 10, risk: "low" },
      ],
      reserveReview: {
        reviewedAt: "2026-07-12",
        reviewer: "fixture reviewer",
        confidence: "manual-review",
        sources: [{ label: "Reserve report", url: "https://example.test/reserves" }],
        rationale: "Fixture non-link review.",
        compositionBasis: "Fixture reserve report",
        scope: "selected-slices",
        knownUnknownExposure: "The basket is not split.",
        knownUnknownExposurePct: 20,
        nonLinkDispositions: [
          {
            reserveIndex: 0,
            reserveName: "USDC vault",
            pct: 20,
            disposition: "insufficient-evidence",
            rationale: "The label alone is not enough to prove the upstream claim.",
            candidateCoinIds: ["usdc-circle", "usdc-other"],
          },
          {
            reserveIndex: 6,
            reserveName: "Old USDC slice",
            pct: 10,
            disposition: "not-applicable",
            rationale: "This fingerprint is intentionally stale for the audit fixture.",
          },
          {
            reserveIndex: 0,
            reserveName: "USDC vault",
            pct: 20,
            disposition: "not-applicable",
            rationale: "This duplicate fingerprint is intentionally stale for the audit fixture.",
          },
        ],
      },
    });
    const audit = buildDependencyCoverageAudit({
      activeCoins: [subject],
      trackedCoins: [
        subject,
        coin({ id: "usdc-circle", symbol: "USDC" }),
        coin({ id: "usdc-other", symbol: "USDC" }),
        coin({ id: "cash-generic", symbol: "CASH" }),
        coin({ id: "cdp-generic", symbol: "CDP" }),
      ],
    });

    expect(audit.materialUnlinkedReserveSlices.map((row) => row.reserveIndex)).toEqual([5, 0, 3, 6]);
    expect(audit.materialUnlinkedReserveSlices.find((row) => row.reserveIndex === 0)).toMatchObject({
      candidateCoinIds: ["usdc-circle", "usdc-other"],
      matchedSymbols: ["USDC"],
      reviewStatus: "unresolved",
      disposition: "insufficient-evidence",
    });
    expect(audit.materialUnlinkedReserveSlices.find((row) => row.reserveIndex === 6)?.reviewStatus).toBe("unreviewed");
    expect(audit.reserveDispositions).toEqual(expect.arrayContaining([
      expect.objectContaining({ reserveIndex: 0, reviewStatus: "unresolved" }),
      expect.objectContaining({ reserveIndex: 0, reviewStatus: "stale" }),
      expect.objectContaining({ reserveIndex: 6, reviewStatus: "stale", currentReserveName: "USDC changed slice" }),
    ]));
    expect(audit.summary).toMatchObject({
      materialUnlinkedReserveSliceCount: 4,
      unresolvedMaterialReserveSliceCount: 4,
      staleReserveDispositionCount: 2,
    });
  });

  it("separates unique-symbol active-target leads into material and sub-1% lanes", () => {
    const subject = coin({
      id: "subject",
      symbol: "SUB",
      dependencies: [{ id: "usdc-circle", weight: 0.02, type: "collateral" }],
      reserves: [
        { name: "Fasanara mGLOBAL position", pct: 44, risk: "high" },
        { name: "f(x) fxSAVE dust", pct: 0.4, risk: "medium" },
        { name: "USDC liquidity", pct: 2, risk: "low" },
      ],
      reserveReview: {
        reviewedAt: "2026-08-31",
        reviewer: "fixture reviewer",
        confidence: "verified",
        sources: [{ label: "Reserve report", url: "https://example.test/reserves" }],
        rationale: "Fixture identity review.",
        compositionBasis: "Fixture reserve report",
        scope: "selected-slices",
        knownUnknownExposure: "No composition assertion beyond the fixture rows.",
        knownUnknownExposurePct: 0,
        nonLinkDispositions: [{
          reserveIndex: 0,
          reserveName: "Fasanara mGLOBAL position",
          pct: 44,
          disposition: "untracked-exogenous-asset",
          rationale: "Fixture intentionally carries the stale untracked classification.",
        }],
      },
    });
    const audit = buildDependencyCoverageAudit({
      activeCoins: [
        subject,
        coin({ id: "mglobal-midas-fasanara", symbol: "mGLOBAL" }),
        coin({ id: "fxsave-f-x-protocol", symbol: "fxSAVE" }),
        coin({ id: "usdc-circle", symbol: "USDC" }),
      ],
    });

    expect(audit.activeUnlinkedReserveSymbolLeads).toEqual([
      expect.objectContaining({
        coinId: "subject",
        reserveIndex: 0,
        candidateCoinId: "mglobal-midas-fasanara",
        reason: "active-target-marked-untracked",
      }),
    ]);
    expect(audit.subMaterialActiveUnlinkedReserveSymbolLeads).toEqual([
      expect.objectContaining({
        coinId: "subject",
        reserveIndex: 1,
        candidateCoinId: "fxsave-f-x-protocol",
        reason: "unique-symbol-target-unlinked",
      }),
    ]);
    expect(audit.summary).toMatchObject({
      activeUnlinkedReserveSymbolLeadCount: 1,
      subMaterialActiveUnlinkedReserveSymbolLeadCount: 1,
    });
  });

  it("surfaces exact manual dependency review gaps and stale relationships", () => {
    const missing = coin({
      id: "missing-review",
      dependencies: [{ id: "upstream", weight: 1, type: "mechanism" }],
    });
    const stale = coin({
      id: "stale-review",
      dependencies: [{ id: "upstream", weight: 1, type: "collateral" }],
      dependencyReview: {
        reviewedAt: "2026-07-12",
        reviewer: "fixture reviewer",
        confidence: "verified",
        sources: [{ label: "Docs", url: "https://example.test/manual" }],
        rationale: "Fixture review with an outdated relationship.",
        relationships: [{ id: "different", type: "collateral", weight: 1, reason: "Stale fixture row." }],
      },
    });
    const audit = buildDependencyCoverageAudit({
      activeCoins: [coin({ id: "upstream" }), coin({ id: "different" }), missing, stale],
    });

    expect(audit.manualDependencyReviewGaps).toEqual([
      expect.objectContaining({ coinId: "missing-review", dependencyId: "upstream", reason: "missing-review" }),
      expect.objectContaining({ coinId: "stale-review", dependencyId: "different", reason: "stale-relationship" }),
      expect.objectContaining({ coinId: "stale-review", dependencyId: "upstream", reason: "missing-relationship" }),
    ]);
    expect(audit.summary.manualDependencyReviewGapCount).toBe(3);
  });

  it("accepts a review of the variantOf wrapper edge the schema already sanctions", () => {
    // `reviewableDependencies` in `shared/lib/stablecoins/schema.ts` counts the
    // `variantOf` wrapper edge alongside manual `dependencies[]`, so ratifying
    // it is valid curation, not a stale row. Reading it as stale is what put
    // `manualDependencyReviewGaps: 1` in the wave-1 ratchet for sUSDai.
    const variant = coin({
      id: "vault-variant",
      variantOf: "parent-asset",
      dependencyReview: {
        reviewedAt: "2026-07-30",
        reviewer: "fixture reviewer",
        confidence: "verified",
        sources: [{ label: "Docs", url: "https://example.test/vault" }],
        rationale: "The whole share resolves serially to the parent through the reviewed vault.",
        relationships: [
          { id: "parent-asset", type: "wrapper", weight: 1, reason: "Serial wrapper claim on the parent." },
        ],
      },
    });
    const audit = buildDependencyCoverageAudit({
      activeCoins: [coin({ id: "parent-asset" }), variant],
    });

    expect(audit.manualDependencyReviewGaps).toEqual([]);
    expect(audit.summary.manualDependencyReviewGapCount).toBe(0);
  });

  it("still reports a relationship that names neither a manual, reserve, nor variant edge", () => {
    const variant = coin({
      id: "vault-variant",
      variantOf: "parent-asset",
      dependencyReview: {
        reviewedAt: "2026-07-30",
        reviewer: "fixture reviewer",
        confidence: "verified",
        sources: [{ label: "Docs", url: "https://example.test/vault" }],
        rationale: "Fixture review naming an edge the coin does not have.",
        relationships: [
          { id: "unrelated", type: "wrapper", weight: 1, reason: "Stale fixture row." },
        ],
      },
    });
    const audit = buildDependencyCoverageAudit({
      activeCoins: [coin({ id: "parent-asset" }), coin({ id: "unrelated" }), variant],
    });

    expect(audit.manualDependencyReviewGaps).toEqual([
      expect.objectContaining({ coinId: "vault-variant", dependencyId: "unrelated", reason: "stale-relationship" }),
    ]);
  });

  it("validates unavailable-target and dynamic adapter registries against current runtime facts", () => {
    const mapped = coin({ id: "mapped", liveReservesConfig: liveConfig("accountable") });
    const upstream = coin({ id: "upstream" });
    const orphan = coin({ id: "orphan" });
    const disposition = (targetId: string) => ({
      targetId,
      expectedLifecycle: "pre-launch" as const,
      action: "retain-reviewed-link" as const,
      reviewer: "reviewer",
      reviewedAt: "2026-07-12",
      sources: [{ label: "Docs", url: "https://example.test/target" }],
      rationale: "Fixture reviewed unavailable target.",
    });
    const audit = buildDependencyCoverageAudit({
      activeCoins: [mapped, upstream, orphan],
      trackedCoins: [mapped, upstream, orphan],
      targetDispositions: [disposition("upstream"), disposition("orphan")],
      adapterMappingReviews: [],
      reportCards: {
        cards: [
          { id: "upstream", overallScore: 80 },
          {
            id: "mapped",
            overallScore: 70,
            rawInputs: { dependencyBaseSource: "live-reserve" },
            dimensions: { dependencyRisk: {} },
          },
        ],
        dependencyGraph: {
          edges: [{ from: "upstream", to: "mapped", weight: 1, type: "collateral" }],
        },
      },
    });

    expect(audit.targetDispositionValidationIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId: "upstream", reason: "lifecycle-mismatch" }),
      expect.objectContaining({ targetId: "upstream", reason: "target-now-scoreable" }),
      expect.objectContaining({ targetId: "orphan", reason: "lifecycle-mismatch" }),
      expect.objectContaining({ targetId: "orphan", reason: "no-current-edge" }),
    ]));
    expect(audit.adapterMappingReviewGaps).toEqual([
      expect.objectContaining({ coinId: "mapped", adapter: "accountable", reason: "missing-review" }),
    ]);
    expect(audit.summary).toMatchObject({
      adapterMappingReviewCoverageEvaluated: true,
      adapterMappingReviewCoverageStatus: "evaluated-with-gaps",
    });
  });

  it("distinguishes clean, gap, and not-evaluated adapter mapping review coverage", () => {
    const mapped = coin({ id: "mapped", liveReservesConfig: liveConfig("accountable") });
    const reportCards = {
      cards: [{
        id: "mapped",
        overallScore: 70,
        rawInputs: { dependencyBaseSource: "live-reserve" },
        dimensions: { dependencyRisk: {} },
      }],
      dependencyGraph: { edges: [] },
    };
    const review = {
      adapter: "accountable" as const,
      reviewer: "reviewer",
      reviewedAt: "2026-09-01",
      sourceFiles: ["worker/src/cron/reserve-adapters/accountable.ts"],
      rationale: "Fixture adapter mapping review.",
    };

    const evaluatedClean = buildDependencyCoverageAudit({
      activeCoins: [mapped],
      reportCards,
      adapterMappingReviews: [review],
    });
    const evaluatedWithGaps = buildDependencyCoverageAudit({
      activeCoins: [mapped],
      reportCards,
      adapterMappingReviews: [],
    });
    const notEvaluated = buildDependencyCoverageAudit({
      activeCoins: [mapped],
      adapterMappingReviews: [],
    });

    expect(evaluatedClean.summary).toMatchObject({
      adapterMappingReviewGapCount: 0,
      adapterMappingReviewCoverageEvaluated: true,
      adapterMappingReviewCoverageStatus: "evaluated-clean",
    });
    expect(evaluatedWithGaps.summary).toMatchObject({
      adapterMappingReviewGapCount: 1,
      adapterMappingReviewCoverageEvaluated: true,
      adapterMappingReviewCoverageStatus: "evaluated-with-gaps",
    });
    expect(notEvaluated.summary).toMatchObject({
      adapterMappingReviewGapCount: 0,
      adapterMappingReviewCoverageEvaluated: false,
      adapterMappingReviewCoverageStatus: "not-evaluated",
    });
    expect(evaluateDependencyCoverageStructure(evaluatedClean)).toEqual([]);
    expect(evaluateDependencyCoverageStructure(evaluatedWithGaps)).toEqual([
      "adapter mapping review gap invariant failed with 1 finding",
    ]);
    expect(evaluateDependencyCoverageStructure(notEvaluated)).toEqual([]);
    expect(evaluateDependencyCoverageStructure(notEvaluated, {
      requireAdapterMappingCoverage: true,
    })).toEqual(["adapter mapping review coverage was not evaluated"]);
  });

  it("reports a retained link missing from the current report even when the static registry still has it", () => {
    const upstream = coin({ id: "upstream", symbol: "UP" });
    const dependent = coin({
      id: "dependent",
      symbol: "DEP",
      dependencies: [{ id: "upstream", weight: 1, type: "collateral" }],
    });
    const audit = buildDependencyCoverageAudit({
      activeCoins: [upstream, dependent],
      targetDispositions: [{
        targetId: "upstream",
        expectedLifecycle: "active",
        action: "retain-reviewed-link",
        reviewer: "reviewer",
        reviewedAt: "2026-08-31",
        sources: [{ label: "Docs", url: "https://example.test/upstream" }],
        rationale: "The reviewed upstream link remains expected in production.",
      }],
      reportCards: {
        cards: [{ id: "upstream", score: null }, { id: "dependent", score: 70 }],
        dependencyGraph: { edges: [] },
      },
    });

    expect(audit.targetDispositionValidationIssues).toContainEqual(expect.objectContaining({
      targetId: "upstream",
      reason: "no-current-edge",
    }));
  });

  it("renders the reviewer-facing sections", () => {
    const audit = buildDependencyCoverageAudit({
      activeCoins,
      stablecoins: stablecoinsPayload,
      generatedAt: "2026-05-24T00:00:00.000Z",
    });

    const markdown = renderDependencyCoverageAuditMarkdown(audit);

    expect(markdown).toContain("# Dependency Coverage Audit");
    expect(markdown).toContain("- Static dependency edges: 2");
    expect(markdown).toContain("## Graph Diagnostics");
    expect(markdown).toContain("## Dependency Edges And Target Status");
    expect(markdown).toContain("## Dependency Provenance");
    expect(markdown).toContain("## Material Stablecoin-Looking Unlinked Reserves");
    expect(markdown).toContain("- Adapter mapping review coverage: not-evaluated");
    expect(markdown).toContain("## Adapter Mapping Review Gaps");
    expect(markdown).toContain("## Highest-Market-Cap Missing Candidates");
    expect(markdown).toContain("LONE (lone-high)");
    expect(markdown).toContain("## depType Without coinId Warnings");
    expect(markdown).toContain("## L2BEAT Deployment Context");
    expect(markdown).toContain("Base Chain (base)");
  });

  it("preserves the empty-report Markdown golden", () => {
    const markdown = renderDependencyCoverageAuditMarkdown(buildDependencyCoverageAudit({
      activeCoins: [],
      generatedAt: "2026-08-28T00:00:00.000Z",
    }));

    expect(sha256(markdown)).toBe("ee9b04ca912dd9a96c7ba55f186dfee32fd1b129cce7d06cadb55f312c46944e");
  });

  it("preserves clipped rows and the over-limit Markdown golden", () => {
    const overLimitCoins = Array.from({ length: 51 }, (_, index) => {
      const suffix = String(index + 1).padStart(2, "0");
      return coin({ id: `candidate-${suffix}`, symbol: `C${suffix}` });
    });
    const markdown = renderDependencyCoverageAuditMarkdown(buildDependencyCoverageAudit({
      activeCoins: overLimitCoins,
      trackedCoins: overLimitCoins,
      generatedAt: "2026-08-28T00:00:00.000Z",
    }));

    expect(sha256(markdown)).toBe("7781d4ad6838b94a8bf54cf89110d298828ccfc4a8097d2b4ab47326134714f1");
    expect(markdown).toContain("coin | mcap | local rank\n--- | ---: | ---:");
    expect(markdown).toContain("_Plus 1 more rows._");
    expect(markdown).not.toContain("C51 (candidate-51)");
  });

  it("enforces zero-tolerance graph invariants and review gaps without requiring edge-count growth", () => {
    const withEdge = buildDependencyCoverageAudit({
      activeCoins: [
        coin({ id: "upstream", symbol: "UP" }),
        coin({ id: "dependent", symbol: "DEP", reserves: [{ name: "UP", pct: 100, risk: "low", coinId: "upstream" }] }),
      ],
    });
    const withoutWrongEdge = buildDependencyCoverageAudit({
      activeCoins: [coin({ id: "upstream", symbol: "UP" }), coin({ id: "dependent", symbol: "DEP" })],
    });
    expect(withEdge.summary.staticEdgeCount).toBe(1);
    expect(withoutWrongEdge.summary.staticEdgeCount).toBe(0);
    expect(evaluateDependencyCoverageStructure(withEdge)).toEqual([]);
    expect(evaluateDependencyCoverageStructure(withoutWrongEdge)).toEqual([]);

    const linkageFailure = buildDependencyCoverageAudit({
      activeCoins: [coin({
        id: "broken",
        reserves: [{ name: "Stablecoin basket", pct: 100, risk: "low", depType: "mechanism" }],
      })],
    });
    // Reserve-slice backlog counters stay out of the gate; the linkage
    // invariant is the only failure this audit shape is allowed to raise.
    expect(evaluateDependencyCoverageStructure(linkageFailure)).toEqual([
      "depType without coinId invariant failed with 1 finding",
    ]);
    expect(linkageFailure.summary.reserveSlicesMissingCoinId).toBe(1);
  });

  it("parses CLI options", () => {
    expect(parseArgs([
      "--report-cards",
      "agents/report-cards.json",
      "--stablecoins",
      "agents/stablecoins.json",
      "--json",
    ])).toMatchObject({
      reportCardsPath: "agents/report-cards.json",
      stablecoinsPath: "agents/stablecoins.json",
      format: "json",
    });
    expect(() => parseArgs(["--check"])).toThrow("Unknown argument: --check");
    expect(() => parseArgs(["--prod", "--api-base", "https://api.example.test"])).toThrow(
      "Choose only one of --prod or --api-base.",
    );
  });

  it("fails on explicit missing input files", async () => {
    await expect(
      runCli(["--report-cards", "agents/missing-report-cards.json"], process.cwd()),
    ).rejects.toThrow("--report-cards file not found");
    await expect(
      runCli(["--stablecoins", "agents/missing-stablecoins.json"], process.cwd()),
    ).rejects.toThrow("--stablecoins file not found");
  });

  it("rejects empty report-card input while preserving static mode", () => {
    expect(() => buildDependencyCoverageAudit({
      activeCoins: [],
      reportCards: { cards: [], dependencyGraph: { edges: [] } },
    })).toThrow("Report-card input is malformed at cards: expected at least one card.");
    expect(() => buildDependencyCoverageAudit({ activeCoins: [] })).not.toThrow();
  });

  it("sends site-origin headers when fetching prod site-data", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const href = String(url);
      return new Response(
        JSON.stringify(href.includes("report-cards")
          ? { cards: [], dependencyGraph: { edges: [] } }
          : { peggedAssets: [] }),
        { status: 200 },
      );
    });
    const fetchImpl: typeof fetch = fetchMock;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await expect(runCli(["--prod", "--json", "--generated-at", "2026-05-24T00:00:00.000Z"], process.cwd(), fetchImpl))
        .rejects.toThrow("Report-card input is malformed at cards: expected at least one card.");
    } finally {
      stdout.mockRestore();
    }

    for (const call of fetchMock.mock.calls) {
      expect(call[1]).toMatchObject({
        headers: expect.objectContaining({
          Origin: "https://pharos.watch",
          Referer: "https://pharos.watch/coverage/",
        }),
      });
    }
  });
});
