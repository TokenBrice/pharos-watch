import { describe, expect, it, vi } from "vitest";
import { buildSelectorRows, type BuildSelectorRowsArgs } from "../data-adapter";
import { hasRequiredSignals } from "../exclusions";
import { selectYieldSource } from "../yield-source";
import { makeInput } from "./fixture";
import type * as ClientRegistry from "@shared/lib/stablecoins/client-registry";

vi.mock("@shared/lib/stablecoins/client-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof ClientRegistry>();
  const base = actual.CLIENT_ACTIVE_META_BY_ID.get("usdc-circle")!;
  const reviewed = { ...base, custodyModel: "cex" as const };
  const unreviewed = { ...base, id: "unreviewed", custodyModel: undefined };
  const coins = [reviewed, unreviewed];
  return {
    ...actual,
    CLIENT_TRACKED_STABLECOINS: coins,
    CLIENT_ACTIVE_META_BY_ID: new Map(coins.map((coin) => [coin.id, coin])),
  };
});
import type {
  BluechipRatingsMap,
  DexLiquidityMap,
  PegSummaryResponse,
  ReportCardsV9CurrentResponse,
  StablecoinListResponse,
  StressSignalsAllResponse,
} from "../../../types";

const EMPTY_ARGS: BuildSelectorRowsArgs = {
  stablecoinsData: null, pegCurrency: null, pegData: null, reportData: null,
  stressData: null, dexData: null, yieldData: null, bluechipData: null, now: 1_700_000_000_000,
};

function adaptYield(ranking: Record<string, unknown>, response: Record<string, unknown> = {}, now = NOW) {
  return buildSelectorRows({
    ...EMPTY_ARGS,
    now,
    yieldData: { rankings: [{ id: "usdc-circle", yieldType: "lending", yieldSource: "Aave",
      apy30d: 5, pharosYieldScore: 80, ...ranking }], ...response } as unknown as BuildSelectorRowsArgs["yieldData"],
  }).rows.get("usdc-circle")!;
}

const NOW = 1_700_000_000_000;

describe("buildSelectorRows", () => {
  it("maps current V9 report-card fields into selector rows", () => {
    const result = buildSelectorRows({
      stablecoinsData: {
        peggedAssets: [
          {
            id: "usdc-circle",
            circulating: { peggedUSD: 32_000_000_000 },
          },
        ],
      } as unknown as StablecoinListResponse,
      pegCurrency: "USD",
      pegData: {
        coins: [
          {
            id: "usdc-circle",
            pegScore: 96,
            currentDeviationBps: 4,
            activeDepeg: false,
            eventCount: 2,
            lastEventAt: 1_690_000_000,
            trackingSpanDays: 2_000,
            priceObservedAt: NOW / 1000,
            priceUpdatedAt: null,
            priceSyncedAt: null,
          },
        ],
        methodology: { version: "peg-v3" },
      } as PegSummaryResponse,
      reportData: {
        methodology: { version: "v9.1" },
        cards: [
          {
            id: "usdc-circle",
            score: 91,
            grade: "A+",
            pillars: {
              backing: { score: 82 },
              exit: { score: 77 },
              control: { score: 64 },
            },
            evidence: { level: "adequate" },
            weakestPillar: { pillar: "control", score: 64 },
            bindingCap: {
              kind: "reason:evidence-cap",
              limit: 85,
              source: "evidence",
              reason: "Evidence cap fixture.",
              binding: true,
            },
            nrReasons: [],
            accessPosture: { freezeExposure: "direct" },
            dependencies: {
              serial: [{ upstreamAssetId: "upstream", score: 70, blocked: false }],
              basket: [],
              cycleBlocked: false,
              reasonCodes: [],
            },
          },
        ],
      } as unknown as ReportCardsV9CurrentResponse,
      stressData: {
        signals: {
          "usdc-circle": { score: 42, computedAt: NOW / 1000 - 60 },
        },
        updatedAt: NOW / 1000,
        methodology: { version: "dews-v3" },
      } as unknown as StressSignalsAllResponse,
      dexData: {
        "usdc-circle": {
          liquidityScore: 88,
          effectiveTvlUsd: 250_000_000,
          concentrationHhi: 0.2,
          chainTvl: { Ethereum: 250_000_000 },
          updatedAt: NOW / 1000,
          dexDeviationBps: 8,
        },
      } as unknown as DexLiquidityMap,
      yieldData: null,
      bluechipData: { "usdc-circle": { grade: "A" } } as unknown as BluechipRatingsMap,
      now: NOW,
    });

    const row = result.rows.get("usdc-circle");
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      safetyScore: 91,
      safetyProvenance: "safety-score-v9",
      safetyGrade: "A+",
      safetyResilienceScore: 82,
      safetyLiquidityScore: 77,
      safetyDecentralizationScore: 64,
      safetyEvidenceLevel: "adequate",
      safetyWeakestPillar: { pillar: "control", score: 64 },
      safetyBindingCap: expect.objectContaining({ limit: 85, reason: "Evidence cap fixture." }),
      safetyNrReasons: [],
      pegScore: 96,
      dewsScore: 42,
      liquidityScore: 88,
      canBeBlacklisted: true,
      custodyModel: "cex",
      bluechipGrade: "A",
      currentDeviationBps: 4,
      supplyUsd: 32_000_000_000,
    });
    expect(result.methodologyVersions).toMatchObject({
      safetyScore: "v9.1",
      pegScoreAndDews: "peg-v3+dews-v3",
    });
    expect(result.datasetHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("controlled custody-model projection", () => {
  it("prefers an opposing curated value and still exercises unreviewed inference", () => {
    const rows = buildSelectorRows(EMPTY_ARGS).rows;
    expect([...rows.keys()]).toEqual(["usdc-circle", "unreviewed"]);
    expect(rows.get("usdc-circle")!.custodyModel).toBe("cex");
    expect(rows.get("unreviewed")!.custodyModel).toBe("institutional-regulated");
  });
});

describe("yield ingestion", () => {
  it("marks structured-tranche model substitution ineligible for V9 coverage", () => {
    const row = adaptYield({ yieldType: "structured-tranche", safetyScore: 99, safetyGrade: "A+" });
    expect(row).toMatchObject({ safetyScore: 99, safetyGrade: "A+", safetyProvenance: "yield-opportunity" });
    expect(hasRequiredSignals(row, "yield").missing).toContain("safety-score-v9");
    expect(adaptYield({ yieldType: "structured-tranche", safetyScore: 99 }).safetyScore).toBeNull();
  });

  it("honors benchmark precedence and explicit false source-switch evidence", () => {
    const response = { provenance: { benchmark: { rate: 3 } }, riskFreeRate: 4 };
    const cases = [
      { ranking: { benchmarkRate: 1, provenance: { benchmarkRate: 2, sourceSwitch: false },
        decisionLedger: { sourceSwitch: true }, sourceRisk: { sourceSwitchCount30d: 2 } }, rate: 1, switched: false },
      { ranking: { provenance: { benchmarkRate: 2 }, decisionLedger: { sourceSwitch: false },
        sourceRisk: { sourceSwitchCount30d: 2 } }, rate: 2, switched: false },
      { ranking: { sourceRisk: { sourceSwitchCount30d: 2 } }, rate: 3, switched: true },
    ];
    for (const { ranking, rate, switched } of cases) {
      expect(adaptYield(ranking, response)).toMatchObject({ benchmarkRate: rate, sourceSwitch: switched });
    }
    expect(adaptYield({}, { riskFreeRate: 4 }).benchmarkRate).toBe(4);
  });

  it("normalizes primary and alternate venues before preference-based source selection", () => {
    const row = adaptYield({
      sourceRisk: { venueProtocol: "Aave", venueChain: "ethereum", venueRiskTier: "medium",
        deploymentPlace: "lending-market", sourceAgeSeconds: 60 },
      altSources: [{ sourceKey: "curve-lp", yieldSource: "Curve", yieldType: "lp-receipt", apy30d: 4,
        sourceRisk: { venueProtocol: "Curve", venueChain: "ethereum", venueRiskTier: "low",
          deploymentPlace: "lp-or-dex", sourceAgeSeconds: 120 } }],
    });
    expect(row.yieldSources).toMatchObject([
      { sourceKey: "Aave:ethereum:lending", venueRiskTier: "mid", deploymentPlace: "lending", isPrimary: true },
      { sourceKey: "curve-lp", venueRiskTier: "low", deploymentPlace: "lp", isPrimary: false },
    ]);
    expect(selectYieldSource(row, makeInput({ profile: "yield", venuePreferences: ["dex"] })))
      .toMatchObject({ sourceKey: "curve-lp", selectionReason: "venue-preference" });
    expect(selectYieldSource(row, makeInput({ profile: "yield", venuePreferences: ["lend"] })))
      .toMatchObject({ sourceKey: "Aave:ethereum:lending" });
  });

  it("prefers observed freshness and derives risk freshness equally from seconds and milliseconds", () => {
    for (const now of [NOW, NOW / 1000]) {
      expect(adaptYield({ provenance: { sourceObservedAt: 123, sourceAgeSeconds: 7 },
        sourceRisk: { sourceAgeSeconds: 60 } }, {}, now).yieldFreshness)
        .toEqual({ capturedAt: 123, ageSeconds: 7 });
      const row = adaptYield({ sourceRisk: { sourceAgeSeconds: 60 },
        altSources: [{ sourceKey: "alt", sourceRisk: { sourceAgeSeconds: 120 } }] }, {}, now);
      expect(row.yieldFreshness).toEqual({ capturedAt: 1_699_999_940, ageSeconds: 60 });
      expect(row.yieldSources![1]!.freshness).toEqual({ capturedAt: 1_699_999_880, ageSeconds: 120 });
    }
  });
});
