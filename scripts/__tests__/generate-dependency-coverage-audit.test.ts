import { describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types";
import type { LiveReserveAdapterKey, LiveReservesConfig } from "@shared/types/live-reserves";
import type { SafetyScoreV9CurrentCard } from "@shared/types/safety-score-v9-public";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/constants";
import {
  makeReportCardsV9Card,
  makeReportCardsV9Pillars,
  makeReportCardsV9Response,
  type ReportCardsV9ResponseFixturePreset,
} from "@shared/test-utils/report-cards-v9";
import { makeCoverageCoin as coin } from "./helpers/coverage-coin";
import { dependencyReview, reserveReview, targetDisposition } from "./generate-dependency-coverage-audit.test-support";
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

const REPORT_CARD_PRESET = {
  safetyScoreIdentity: {
    model: "v9",
    schemaVersion: 1,
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    policyId: "safety-score-v9",
    policyDigest: "a".repeat(64),
    evaluationBuildDigest: "b".repeat(64),
    baseInputGenerationId: `report-cards-input:v1:${"c".repeat(64)}`,
    publicationGenerationId: "v9-publication-audit-test",
  },
  defaultUpdatedAt: 1_752_534_060,
  asOfSec: 1_752_534_000,
  source: {
    candidateId: "safety-score-v9:v1:audit-test",
    factSetDigest: "c".repeat(64),
    resultDigest: "d".repeat(64),
    sourceGenerations: { reportCards: "source-1" },
  },
} satisfies ReportCardsV9ResponseFixturePreset;

interface ReportCardInput {
  id: string;
  score?: number | null;
  overallScore?: number | null;
  backingFromLiveReserves?: boolean;
  dependencyCoverage?: SafetyScoreV9CurrentCard["dependencyCoverage"];
}

interface ReportCardEdgeInput {
  from: string;
  to: string;
  kind?: "serial" | "basket";
  materiality?: "serial" | "serial-blocked" | "basket-weighted" | "basket-bounded-unknown";
  weight: number | null;
  type?: "collateral" | "mechanism";
}

function reportCardFixture(input: {
  cards: ReportCardInput[];
  dependencyGraph: { edges: ReportCardEdgeInput[] };
  methodologyVersion?: string;
}) {
  const scoreById = new Map(input.cards.map((card) => [card.id, card.score ?? card.overallScore ?? null]));
  const cards = input.cards
    .map((inputCard): SafetyScoreV9CurrentCard => {
      const score = scoreById.get(inputCard.id) ?? null;
      const localCauseGaps = [...new Set(input.dependencyGraph.edges
        .filter((edge) => edge.to === inputCard.id && scoreById.get(edge.from) == null)
        .map((edge) => `parent:${edge.from}:unknown`))].sort();
      const serial = input.dependencyGraph.edges
        .filter((edge) => edge.to === inputCard.id && (edge.kind === "serial" || edge.type === "mechanism"))
        .map((edge) => ({
          upstreamAssetId: edge.from,
          score: scoreById.get(edge.from) ?? null,
          ratingStatus: scoreById.get(edge.from) == null ? "not-rated" as const : "rated" as const,
          partialEvidence: null,
          causeGapRefs: scoreById.get(edge.from) == null ? [localCauseGaps.indexOf(`parent:${edge.from}:unknown`)] : [],
          limitedEvidenceCauses: scoreById.get(edge.from) == null ? ["U" as const] : [],
          blocked: edge.materiality === "serial-blocked",
        }))
        .sort((left, right) => left.upstreamAssetId.localeCompare(right.upstreamAssetId));
      const basket = input.dependencyGraph.edges
        .filter((edge) => edge.to === inputCard.id && edge.kind !== "serial" && edge.type !== "mechanism")
        .map((edge) => ({
          upstreamAssetId: edge.from,
          weight: edge.weight ?? 0,
          score: scoreById.get(edge.from) ?? null,
          ratingStatus: scoreById.get(edge.from) == null ? "not-rated" as const : "rated" as const,
          partialEvidence: null,
          causeGapRefs: scoreById.get(edge.from) == null ? [localCauseGaps.indexOf(`parent:${edge.from}:unknown`)] : [],
          limitedEvidenceCauses: scoreById.get(edge.from) == null ? ["U" as const] : [],
          boundedUnknown: edge.materiality === "basket-bounded-unknown",
        }))
        .sort((left, right) => left.upstreamAssetId.localeCompare(right.upstreamAssetId));
      const unrated = score === null;
      return makeReportCardsV9Card({
        id: inputCard.id,
        localCauseGaps,
        score,
        backingFromLiveReserves: inputCard.backingFromLiveReserves,
        dependencyCoverage: inputCard.dependencyCoverage,
        ...(unrated ? {
          grade: "NR",
          ratingStatus: "not-rated",
          qualityScore: null,
          pegMultiplier: null,
          pegAdjustedScore: null,
          pillars: makeReportCardsV9Pillars({ backing: null, exit: null, control: null }),
          weakestPillar: null,
          nrReasons: [{
            code: "missing-pillar",
            message: "Required pillar evidence is missing.",
            field: "backing",
            origin: "asset",
          }],
          breakdowns: null,
        } : {}),
        dependencies: { serial, basket, cycleBlocked: false, reasonCodes: [] },
      });
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const preset = {
    ...REPORT_CARD_PRESET,
    safetyScoreIdentity: {
      ...REPORT_CARD_PRESET.safetyScoreIdentity,
      methodologyVersion: input.methodologyVersion ?? SAFETY_SCORE_METHODOLOGY_VERSION,
    },
  };
  return makeReportCardsV9Response(preset, () => makeReportCardsV9Card(), { cards });
}

const activeCoins: StablecoinMeta[] = [
  coin({ id: "usdc-circle", symbol: "USDC", name: "USD Coin" }),
  coin({ id: "usdt-tether", symbol: "USDT", name: "Tether USD" }),
  coin({
    id: "wrap-usdc",
    symbol: "wUSDC",
    reserves: [{ name: "USDC", pct: 100, risk: "low", coinId: "usdc-circle", depType: "collateral" }],
  }),
  coin({
    id: "manual-usdt",
    symbol: "mUSDT",
    dependencies: [{ id: "usdt-tether", weight: 0.5, type: "mechanism" }],
    dependencyReview: dependencyReview([{
      id: "usdt-tether",
      type: "mechanism",
      weight: 0.5,
      reason: "Fixture mechanism dependency.",
    }]),
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


describe("generate-dependency-coverage-audit", () => {
  it("warns on publication skew while retaining provenance failures and deferring authored-kind checks", () => {
    const activeCoins = [
      coin({ id: "upstream" }),
      coin({ id: "dependent", reserves: [
        { name: "Mechanism claim", pct: 100, risk: "low", coinId: "upstream", depType: "mechanism" },
      ] }),
    ];
    const reportCards = reportCardFixture({
      methodologyVersion: `${SAFETY_SCORE_METHODOLOGY_VERSION}.1`,
      cards: [{ id: "upstream", score: 80 }, { id: "dependent", score: 70 }],
      dependencyGraph: { edges: [{ from: "upstream", to: "dependent", kind: "basket", weight: 1 }] },
    });
    const audit = buildDependencyCoverageAudit({
      activeCoins, reportCards,
      targetDispositions: [targetDisposition("upstream", "active", { reviewer: "" })],
    });
    expect(audit.summary.publicationComparisonStatus).toBe("checkout-production-skew");
    expect(audit.summary.publishedKindMismatchCount).toBe(1);
    expect(audit.warnings.some((warning) => warning.startsWith("checkout-production-skew:"))).toBe(true);
    expect(evaluateDependencyCoverageStructure(audit, { publishedOnly: true })).toEqual([
      "target disposition validation issue invariant failed with 1 finding",
    ]);
    expect(evaluateDependencyCoverageStructure(audit)).toContain(
      "published kind mismatch invariant failed with 1 finding",
    );
    const matched = buildDependencyCoverageAudit({ activeCoins, reportCards: reportCardFixture({
      cards: [{ id: "upstream", score: 80 }, { id: "dependent", score: 70 }],
      dependencyGraph: { edges: [{ from: "upstream", to: "dependent", kind: "basket", weight: 1 }] },
    }) });
    expect(matched.summary.publicationComparisonStatus).toBe("matched");
    expect(evaluateDependencyCoverageStructure(matched, { publishedOnly: true })).toEqual([
      "published kind mismatch invariant failed with 1 finding",
    ]);
  });

  it("accepts several unit-weight serial parents while rejecting overweight baskets and partial serial claims", () => {
    const audit = buildDependencyCoverageAudit({ activeCoins: [
      coin({ id: "parent-a" }), coin({ id: "parent-b" }),
      coin({ id: "serial", dependencies: [
        { id: "parent-a", weight: 1, type: "wrapper" },
        { id: "parent-b", weight: 1, type: "mechanism" },
      ] }),
      coin({ id: "basket", dependencies: [
        { id: "parent-a", weight: 0.6, type: "collateral" },
        { id: "parent-b", weight: 0.6, type: "collateral" },
      ] }),
      coin({ id: "partial-serial", dependencies: [{ id: "parent-a", weight: 0.9, type: "mechanism" }] }),
    ] });
    expect(audit.overweightEffectiveSets).toEqual([
      expect.objectContaining({ coinId: "basket", totalWeight: 1.2 }),
    ]);
    expect(audit.summary.invalidSerialDependencyWeightCount).toBe(1);
    expect(evaluateDependencyCoverageStructure(audit)).toContain(
      "invalid serial dependency weight invariant failed with 1 finding",
    );
  });

  it("does not turn zero-exposure classification rows into missing-link leads", () => {
    const audit = buildDependencyCoverageAudit({ activeCoins: [
      coin({ id: "upstream", symbol: "USDC" }),
      coin({ id: "subject", reserves: [
        { name: "USDC classification", pct: 0, risk: "low", sourceKey: "classification:usdc" },
        { name: "Stablecoin residual classification", pct: 0, risk: "low", sourceKey: "classification:residual" },
        { name: "Cash", pct: 100, risk: "very-low" },
      ] }),
    ] });
    expect(audit.reserveSlicesMissingCoinId.map((row) => row.reserveName)).toEqual(["Cash"]);
    expect(audit.materialUnlinkedReserveSlices).toEqual([]);
    expect(audit.subMaterialActiveUnlinkedReserveSymbolLeads).toEqual([]);
  });

  it("gates missing authored types and published kind disagreements", () => {
    const upstream = coin({ id: "upstream" });
    const dependent = coin({ id: "dependent", reserves: [
      { name: "Legacy untyped", pct: 20, risk: "low", coinId: "upstream" },
      { name: "Reviewed mechanism", pct: 80, risk: "low", coinId: "upstream", depType: "mechanism" },
    ] });
    const reportCards = reportCardFixture({
      cards: [{ id: "upstream", score: 80 }, { id: "dependent", score: 70 }],
      dependencyGraph: { edges: [{ from: "upstream", to: "dependent", kind: "basket", weight: 0.8 }] },
    });
    const audit = buildDependencyCoverageAudit({ activeCoins: [upstream, dependent], reportCards });
    expect(audit.summary.coinIdWithoutDepTypeCount).toBe(1);
    expect(audit.summary.publishedKindMismatchCount).toBe(1);
    expect(evaluateDependencyCoverageStructure(audit, { publishedOnly: true })).toEqual([
      "published kind mismatch invariant failed with 1 finding",
      "coinId without depType invariant failed with 1 finding",
    ]);
    const staticAudit = buildDependencyCoverageAudit({ activeCoins: [upstream, dependent] });
    expect(staticAudit.summary.publishedKindMismatchCount).toBeNull();
    expect(evaluateDependencyCoverageStructure(staticAudit)).toEqual([
      "invalid serial dependency weight invariant failed with 1 finding",
      "coinId without depType invariant failed with 1 finding",
    ]);
  });

  it("gates untyped published runtime coverage even when authored reserves are typed", () => {
    const activeCoins = [
      coin({ id: "upstream" }),
      coin({ id: "dependent", reserves: [
        { name: "USDC", pct: 100, risk: "low", coinId: "upstream", depType: "collateral" },
      ] }),
    ];
    const cards: ReportCardInput[] = [{ id: "upstream", score: 80 }, {
      id: "dependent", score: 70, dependencyCoverage: [{
        upstreamLabel: "USDC", upstreamAssetId: "upstream", share: 1,
        reason: "coinId-without-depType", sourceAsOf: null, identityVerified: true,
      }],
    }];
    const audit = buildDependencyCoverageAudit({
      activeCoins, reportCards: reportCardFixture({ cards, dependencyGraph: { edges: [] } }),
    });
    expect(audit.summary.coinIdWithoutDepTypeCount).toBe(0);
    expect(audit.summary.publishedCoinIdWithoutDepTypeCount).toBe(1);
    expect(evaluateDependencyCoverageStructure(audit, { publishedOnly: true })).toEqual([
      "published runtime coinId without depType invariant failed with 1 finding",
    ]);
    const skewedAudit = buildDependencyCoverageAudit({
      activeCoins, reportCards: reportCardFixture({
        cards, dependencyGraph: { edges: [] }, methodologyVersion: "0.0",
      }),
    });
    expect(skewedAudit.summary.publicationComparisonStatus).toBe("checkout-production-skew");
    expect(skewedAudit.summary.publishedCoinIdWithoutDepTypeCount).toBe(1);
    expect(evaluateDependencyCoverageStructure(skewedAudit, { publishedOnly: true })).toEqual([]);
  });

  it("counts manual collateral omitted by the linked reserve identity set", () => {
    const audit = buildDependencyCoverageAudit({ activeCoins: [
      coin({ id: "represented" }), coin({ id: "omitted" }),
      coin({ id: "dependent", reserves: [
        { name: "Represented reserve", pct: 80, risk: "low", coinId: "represented", depType: "collateral" },
      ], dependencies: [{ id: "omitted", type: "collateral", weight: 0.2 }],
      dependencyReview: dependencyReview([{ id: "omitted", type: "collateral", weight: 0.2, reason: "Manual holding." }]) }),
    ] });
    expect(audit.summary.mixedSourceGuardCount).toBe(1);
    expect(evaluateDependencyCoverageStructure(audit)).toContain(
      "mixed-source authoring guard invariant failed with 1 finding",
    );
  });

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
      reportCards: reportCardFixture({
        cards: [{ id: "wrap-usdc", overallScore: 70 }],
        dependencyGraph: {
          edges: [{ from: "usdc-circle", to: "wrap-usdc", weight: 1, type: "collateral" }],
        },
      }),
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

  it("accepts the current V9 report contract and native dependency lanes", () => {
    const audit = buildDependencyCoverageAudit({
      activeCoins: [
        coin({ id: "serial-upstream", symbol: "SER" }),
        coin({ id: "basket-upstream", symbol: "BSK" }),
        coin({ id: "dependent", symbol: "DEP" }),
      ],
      reportCards: reportCardFixture({
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
            },
            {
              from: "basket-upstream",
              to: "dependent",
              kind: "basket",
              materiality: "basket-weighted",
              weight: 0.25,
            },
          ],
        },
      }),
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

  it("preserves blocked and bounded lanes and unwraps site-data payloads", () => {
    const coins = [coin({ id: "upstream" }), coin({ id: "dependent" })];
    const reportCards = reportCardFixture({
      cards: [{ id: "upstream", score: null }, { id: "dependent", score: 70 }],
      dependencyGraph: { edges: [
        { from: "upstream", to: "dependent", kind: "serial", materiality: "serial-blocked", weight: null },
        { from: "upstream", to: "dependent", kind: "basket", materiality: "basket-bounded-unknown", weight: 0.3 },
      ] },
    });
    const input = { activeCoins: coins, generatedAt: "2026-09-01T00:00:00.000Z" };
    const audit = buildDependencyCoverageAudit({ ...input, reportCards });
    expect(audit.dependencyEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({ reportMateriality: "serial-blocked", reportedWeight: null, targetScoreability: "active-nr" }),
      expect.objectContaining({ reportMateriality: "basket-bounded-unknown", reportedWeight: 0.3, targetScoreability: "active-nr" }),
    ]));
    expect(buildDependencyCoverageAudit({ ...input, reportCards: { payload: reportCards } })).toEqual(audit);
  });

  it("rejects legacy and malformed report-card inputs through the canonical schema", () => {
    expect(() => buildDependencyCoverageAudit({
      activeCoins: [],
      reportCards: {
        cards: [{ id: "dependent", overallScore: 70 }],
        dependencyGraph: { edges: [] },
      },
    })).toThrow("Report-card input is malformed");
    expect(() => buildDependencyCoverageAudit({
      activeCoins: [],
      reportCards: {
        ...reportCardFixture({
          cards: [{ id: "dependent", score: 70 }],
          dependencyGraph: { edges: [] },
        }),
        model: "v8",
      },
    })).toThrow("model");
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
          { id: "target-b", weight: 0.5, type: "collateral" },
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
          { name: "Route one", pct: 40, risk: "low", coinId: "target-a", depType: "collateral" },
          { name: "Route two", pct: 30, risk: "medium", coinId: "target-a", depType: "collateral" },
        ],
      }),
    ];
    const audit = buildDependencyCoverageAudit({ activeCoins: defectCoins });

    expect(audit.summary).toMatchObject({
      staticSelfEdgeCount: 1,
      staticDuplicateEdgeCount: 1,
      staticStronglyConnectedComponentCount: 1,
      rawAuthoredDuplicateCount: 1,
      overweightEffectiveSetCount: 1,
    });
    expect(audit.staticGraphDiagnostics.stronglyConnectedComponents).toEqual([["cycle-a", "cycle-b"]]);
    expect(audit.rawAuthoredDuplicates).toEqual(expect.arrayContaining([
      expect.objectContaining({ coinId: "duplicate", source: "dependencies", indices: [0, 1] }),
      expect.objectContaining({ coinId: "split-reserve", source: "reserves", classification: "split positions", indices: [0, 1] }),
    ]));
    expect(audit.overweightEffectiveSets.map((row) => row.coinId)).toEqual(["overweight"]);
  });

  it("reports runtime lifecycle, scoreability, canonical provenance, availability, and adapter review", () => {
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
    const reportCards = reportCardFixture({
      cards: [
        { id: "scoreable", score: 82 },
        { id: "active-nr", score: null },
        { id: "dependent", score: 70 },
        { id: "legacy", score: 60 },
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
    });
    const targetDispositions = [
      targetDisposition("active-nr", "active" as const),
      targetDisposition("prelaunch", "pre-launch" as const),
      targetDisposition("frozen", "frozen" as const),
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
      source: null,
      baseSource: null,
      availableWeight: null,
      unavailableWeight: null,
      mappedLiveReserveShare: null,
      unmappedLiveReserveShare: null,
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
      reserveReview: reserveReview({ confidence: "manual-review", knownUnknownExposurePct: 20, nonLinkDispositions: [
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
      ] }),
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
      reserveReview: reserveReview({ confidence: "verified", knownUnknownExposurePct: 0, nonLinkDispositions: [{
        reserveIndex: 0,
        reserveName: "Fasanara mGLOBAL position",
        pct: 44,
        disposition: "untracked-exogenous-asset",
        rationale: "Fixture intentionally carries the stale untracked classification.",
      }] }),
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
      dependencyReview: dependencyReview([{ id: "different", type: "collateral", weight: 1, reason: "Stale fixture row." }]),
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
      dependencyReview: dependencyReview([
        { id: "parent-asset", type: "wrapper", weight: 1, reason: "Serial wrapper claim on the parent." },
      ]),
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
      dependencyReview: dependencyReview([
        { id: "unrelated", type: "wrapper", weight: 1, reason: "Stale fixture row." },
      ]),
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
    const audit = buildDependencyCoverageAudit({
      activeCoins: [mapped, upstream, orphan],
      trackedCoins: [mapped, upstream, orphan],
      targetDispositions: [targetDisposition("upstream", "pre-launch"), targetDisposition("orphan", "pre-launch")],
      adapterMappingReviews: [],
      reportCards: reportCardFixture({
        cards: [
          { id: "upstream", score: 80 },
          { id: "mapped", score: 70, backingFromLiveReserves: true },
        ],
        dependencyGraph: {
          edges: [{ from: "upstream", to: "mapped", weight: 1, type: "collateral" }],
        },
      }),
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

  it("fails the structural evaluator for a malformed target disposition", () => {
    const upstream = coin({ id: "upstream" });
    const dependent = coin({
      id: "dependent",
      reserves: [{ name: "Upstream", pct: 100, risk: "low", coinId: "upstream", depType: "collateral" }],
    });
    const audit = buildDependencyCoverageAudit({
      activeCoins: [upstream, dependent],
      trackedCoins: [upstream, dependent],
      targetDispositions: [targetDisposition("upstream", "active", { reviewer: "" })],
    });

    expect(audit.targetDispositionValidationIssues).toEqual([
      expect.objectContaining({ targetId: "upstream", reason: "invalid-provenance" }),
    ]);
    expect(evaluateDependencyCoverageStructure(audit)).toEqual([
      "target disposition validation issue invariant failed with 1 finding",
    ]);
  });

  it("does not require adapter mapping review for live backing without a published mapped dependency", () => {
    const upstream = coin({ id: "upstream" });
    const mapped = coin({
      id: "mapped",
      reserves: [{ name: "Upstream", pct: 100, risk: "low", coinId: "upstream", depType: "collateral" }],
      liveReservesConfig: liveConfig("accountable"),
    });
    const reportCards = reportCardFixture({
      cards: [{ id: "mapped", score: 70, backingFromLiveReserves: true }],
      dependencyGraph: { edges: [] },
    });
    const review = {
      adapter: "accountable" as const,
      reviewer: "reviewer",
      reviewedAt: "2026-09-01",
      sourceFiles: ["worker/src/cron/reserve-adapters/accountable.ts"],
      rationale: "Fixture adapter mapping review.",
    };

    const evaluatedClean = buildDependencyCoverageAudit({
      activeCoins: [upstream, mapped],
      reportCards,
      adapterMappingReviews: [review],
    });
    const reportCardGap = buildDependencyCoverageAudit({
      activeCoins: [upstream, mapped],
      reportCards,
      adapterMappingReviews: [],
    });
    const staticGap = buildDependencyCoverageAudit({
      activeCoins: [upstream, mapped],
      adapterMappingReviews: [],
    });

    expect(evaluatedClean.summary).toMatchObject({
      adapterMappingReviewGapCount: 0,
      adapterMappingReviewCoverageEvaluated: true,
      adapterMappingReviewCoverageStatus: "evaluated-clean",
    });
    expect(reportCardGap.summary).toMatchObject({
      adapterMappingReviewGapCount: 0,
      adapterMappingReviewCoverageEvaluated: true,
      adapterMappingReviewCoverageStatus: "evaluated-clean",
    });
    expect(staticGap.summary).toMatchObject({
      adapterMappingReviewGapCount: 1,
      adapterMappingReviewCoverageEvaluated: true,
      adapterMappingReviewCoverageStatus: "evaluated-with-gaps",
    });
    expect(evaluateDependencyCoverageStructure(evaluatedClean)).toEqual([]);
    expect(evaluateDependencyCoverageStructure(reportCardGap)).toEqual([]);
    expect(evaluateDependencyCoverageStructure(staticGap, {
      requireAdapterMappingCoverage: true,
    })).toEqual(["adapter mapping review gap invariant failed with 1 finding"]);
  });

  it.each(["suspended", "staged"] as const)("retains explicit %s provenance only for all-suspended authored bindings", (status) => {
    const config = { ...liveConfig("sodax-sonic"), suspended: { reason: "Wrong liability identity", since: "2026-10-08" } };
    const source = coin({ id: "legacy", liveReservesConfig: config });
    const review = {
      adapter: "sodax-sonic", reviewer: "reviewer", reviewedAt: "2026-10-08",
      sourceFiles: ["worker/src/cron/reserve-adapters/sodax-sonic.ts"], rationale: "New-token census cannot attest legacy liabilities.",
      retainedBinding: { status, reason: "The only authored binding is suspended for wrong identity." },
    };
    const audit = buildDependencyCoverageAudit({
      activeCoins: [], sourceCoins: [source], adapterMappingReviews: [review],
    });
    expect(audit.adapterMappingReviewGaps).toEqual([]);
    expect(evaluateDependencyCoverageStructure(audit, { requireAdapterMappingCoverage: true })).toEqual([]);
    expect(audit.dependencyEdges).toEqual([]);

    const { retainedBinding: _retention, ...unmarked } = review;
    const unmarkedAudit = buildDependencyCoverageAudit({
      activeCoins: [], sourceCoins: [source], adapterMappingReviews: [unmarked],
    });
    expect(unmarkedAudit.adapterMappingReviewGaps).toEqual([
      expect.objectContaining({ adapter: "sodax-sonic", reason: "stale-review" }),
    ]);
    for (const sourceCoins of [[], [coin({ id: "new", liveReservesConfig: liveConfig("sodax-sonic") })], [source, coin({ id: "new", liveReservesConfig: liveConfig("sodax-sonic") })]]) {
      const invalid = buildDependencyCoverageAudit({ activeCoins: [], sourceCoins, adapterMappingReviews: [review] });
      expect(invalid.adapterMappingReviewGaps).toContainEqual(expect.objectContaining({ reason: "stale-review" }));
      expect(invalid.adapterMappingReviewGaps).toContainEqual(expect.objectContaining({ reason: "invalid-provenance" }));
    }
    const blankReason = buildDependencyCoverageAudit({
      activeCoins: [], sourceCoins: [source], adapterMappingReviews: [{ ...review, retainedBinding: { status, reason: " " } }],
    });
    expect(blankReason.adapterMappingReviewGaps).toContainEqual(expect.objectContaining({ reason: "stale-review" }));
    expect(blankReason.adapterMappingReviewGaps).toContainEqual(expect.objectContaining({ reason: "invalid-provenance" }));
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
      targetDispositions: [targetDisposition("upstream", "active")],
      reportCards: reportCardFixture({
        cards: [{ id: "upstream", score: null }, { id: "dependent", score: 70 }],
        dependencyGraph: { edges: [] },
      }),
    });

    expect(audit.targetDispositionValidationIssues).toContainEqual(expect.objectContaining({
      targetId: "upstream",
      reason: "no-current-edge",
    }));
  });


  it("retains the first and 50th candidate while clipping the 51st", () => {
    const overLimitCoins = Array.from({ length: 51 }, (_, index) => {
      const suffix = String(index + 1).padStart(2, "0");
      return coin({ id: `candidate-${suffix}`, symbol: `C${suffix}` });
    });
    const markdown = renderDependencyCoverageAuditMarkdown(buildDependencyCoverageAudit({
      activeCoins: overLimitCoins,
      trackedCoins: overLimitCoins,
      generatedAt: "2026-08-28T00:00:00.000Z",
    }));

    expect(markdown).toContain("C01 (candidate-01)");
    expect(markdown).toContain("C50 (candidate-50)");
    expect(markdown).not.toContain("C51 (candidate-51)");
  });

  it("enforces zero-tolerance graph invariants and review gaps without requiring edge-count growth", () => {
    const withEdge = buildDependencyCoverageAudit({
      activeCoins: [
        coin({ id: "upstream", symbol: "UP" }),
        coin({ id: "dependent", symbol: "DEP", reserves: [{ name: "UP", pct: 100, risk: "low", coinId: "upstream", depType: "collateral" }] }),
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
      reportCards: reportCardFixture({ cards: [], dependencyGraph: { edges: [] } }),
    })).toThrow("Report-card input is malformed at cards: expected at least one card.");
    expect(() => buildDependencyCoverageAudit({ activeCoins: [] })).not.toThrow();
  });

  it("sends site-origin headers when fetching prod site-data", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const href = String(url);
      return new Response(
        JSON.stringify(href.includes("report-cards")
          ? reportCardFixture({ cards: [], dependencyGraph: { edges: [] } })
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
