import { describe, expect, it } from "vitest";
import { buildSelectorRows } from "../data-adapter";
import { CLIENT_ACTIVE_META_BY_ID } from "../../stablecoins/client-registry";
import { inferResilienceDefaults } from "../../report-card-policy";
import type {
  BluechipRatingsMap,
  DexLiquidityMap,
  PegSummaryResponse,
  ReportCardsV9CurrentResponse,
  StablecoinListResponse,
  StressSignalsAllResponse,
} from "../../../types";

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
      pegScore: 96,
      dewsScore: 42,
      liquidityScore: 88,
      canBeBlacklisted: true,
      // Curated review, not the V8 `backing × governance` inference table.
      // USDC is reviewed `institutional-top`; the table can only ever answer
      // `onchain` or `institutional-regulated`, and answered the latter here.
      custodyModel: "institutional-top",
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

/**
 * `selector-v2.1` custody projection.
 *
 * The row used to derive `custodyModel` from `inferResilienceDefaults`, a
 * 9-cell `backing × governance` table whose entire range is `onchain` and
 * `institutional-regulated`. That made the Selector structurally unable to
 * observe the other four `CUSTODY_MODEL_VALUES`, so exchange-custodied coins
 * cleared the "on-chain only" custody rail and unregulated institutional
 * custody cleared the "regulated only" rail. Curated review is now the
 * authority; the inference survives only as the fallback.
 *
 * These assertions are curation-independent: they pin the projection rule and
 * the fact that the out-of-range values are reachable, not any one coin.
 */
describe("custody-model projection", () => {
  const rows = buildSelectorRows({
    stablecoinsData: null,
    pegCurrency: null,
    pegData: null,
    reportData: null,
    stressData: null,
    dexData: null,
    yieldData: null,
    bluechipData: null,
    now: NOW,
  }).rows;

  it("prefers curated custody over the inference table", () => {
    const mismatched: string[] = [];
    for (const [id, row] of rows) {
      const curated = CLIENT_ACTIVE_META_BY_ID.get(id)?.custodyModel;
      if (curated != null && row.custodyModel !== curated) {
        mismatched.push(`${id}: ${row.custodyModel} != ${curated}`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  it("falls back to the inference table when no custody review exists", () => {
    const mismatched: string[] = [];
    for (const [id, row] of rows) {
      const meta = CLIENT_ACTIVE_META_BY_ID.get(id);
      if (meta == null || meta.custodyModel != null) continue;
      const inferred = inferResilienceDefaults(meta.flags.backing, meta.flags.governance).custodyModel;
      if (row.custodyModel !== inferred) mismatched.push(`${id}: ${row.custodyModel} != ${inferred}`);
    }
    expect(mismatched).toEqual([]);
  });

  it("reaches custody models the inference table cannot produce", () => {
    const observed = new Set(Array.from(rows.values(), (row) => row.custodyModel));
    // `cex` is the value the old projection was blind to and the one both
    // custody rails must now reject.
    expect(observed.has("cex")).toBe(true);
    expect(
      ["institutional-top", "institutional-unregulated", "institutional-sanctioned"].some((model) =>
        observed.has(model),
      ),
    ).toBe(true);
  });
});
