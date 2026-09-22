import { describe, expect, it } from "vitest";
import complianceAsset from "@shared/data/stablecoins/coins.compliance.generated.json";
import type { StablecoinClientMeta } from "@shared/types/stablecoin-client-meta";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import {
  buildCoverageMatrixModel,
  type CoverageMatrixModelInput,
  type CoverageMatrixQueryKey,
} from "@/lib/coverage-matrix-model";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";

/**
 * Field-checked partial: a renamed or reshaped production field fails to
 * compile here instead of silently arriving as `undefined` (TS10-06).
 */
type DeepPartial<T> = T extends readonly (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

type QueryPayload<K extends CoverageMatrixQueryKey> = NonNullable<CoverageMatrixModelInput[K]["data"]>;

type MatrixInputOverrides = {
  [K in CoverageMatrixQueryKey]?: DeepPartial<QueryPayload<K>>;
} & {
  activeStablecoins?: readonly StablecoinClientMeta[];
  errors?: Partial<Record<CoverageMatrixQueryKey, unknown>>;
};

const DEFAULT_PAYLOADS: { [K in CoverageMatrixQueryKey]: DeepPartial<QueryPayload<K>> } = {
  stablecoins: { peggedAssets: [] },
  pegSummary: { summary: {}, coins: [] },
  dexLiquidity: {},
  redemptionBackstops: { coins: {} },
  yieldRankings: { rankings: [] },
  mintBurnFlows: { gauge: {}, hourly: [], coins: [] },
  reportCards: makeReportCardsV9Response({ cards: [] }),
};

function makeMatrixInput({ activeStablecoins, errors, ...payloads }: MatrixInputOverrides = {}): CoverageMatrixModelInput {
  const resources = Object.fromEntries(
    (Object.keys(DEFAULT_PAYLOADS) as CoverageMatrixQueryKey[]).map((key) => {
      const error = errors?.[key] ?? null;
      return [
        key,
        {
          data: error ? undefined : (payloads[key] ?? DEFAULT_PAYLOADS[key]),
          dataUpdatedAt: 7,
          error,
          meta: null,
        },
      ];
    }),
  ) as unknown as CoverageMatrixModelInput;
  return activeStablecoins ? { ...resources, activeStablecoins } : resources;
}

function trackedMeta(id: string): StablecoinClientMeta {
  const meta = CLIENT_TRACKED_META_BY_ID.get(id);
  if (!meta) throw new Error(`untracked stablecoin fixture: ${id}`);
  return meta;
}

describe("buildCoverageMatrixModel", () => {
  it("joins compliance profiles onto compact registry rows and aggregates assessed coverage", () => {
    const model = buildCoverageMatrixModel(
      makeMatrixInput({
        stablecoins: { peggedAssets: [{ id: "usdc-circle", circulating: { peggedUSD: 1_000 } }] },
      }),
    );
    const profiles = new Map(complianceAsset.map((entry) => [entry.id, entry]));

    for (const key of ["mica", "genius"] as const) {
      const assessedRows = model.rows.filter((row) => profiles.get(row.id)?.[key]);
      expect(assessedRows.length).toBeGreaterThan(0);
      for (const row of model.rows) {
        const profile = profiles.get(row.id);
        const expectedKind = key === "mica" ? profile?.mica?.status : profile?.genius?.authorizationStatus;
        expect(row.statuses[key].kind, `${row.id}: ${key}`).toBe(expectedKind ?? "unassessed");
        expect(row.statuses[key].available).toBe(expectedKind !== undefined);
      }
      expect(model.featureSummaries.find((summary) => summary.feature.key === key)).toMatchObject({
        availableCount: assessedRows.length,
        totalCount: model.rows.length,
        coveragePct: (assessedRows.length / model.rows.length) * 100,
        mcapSharePct: 100,
      });
    }
  });

  it("builds the pure coverage matrix model from query snapshots", () => {
    const model = buildCoverageMatrixModel(
      makeMatrixInput({
        stablecoins: {
          peggedAssets: [
            { id: "usdc-circle", name: "USD Coin", symbol: "USDC", circulating: { peggedUSD: 1_000 } },
          ],
        },
        pegSummary: {
          summary: {},
          coins: [
            {
              id: "usdc-circle",
              consensusSources: ["CoinGecko", "DefiLlama", "Pyth"],
              priceConfidence: "high",
            },
          ],
        },
        dexLiquidity: { "usdc-circle": { coverageClass: "primary" } },
        yieldRankings: { rankings: [{ id: "usdc-circle" }] },
        mintBurnFlows: {
          gauge: {},
          hourly: [],
          coins: [{ stablecoinId: "usdc-circle", coverage: { status: "full" } }],
        },
        reportCards: makeReportCardsV9Response({ cards: [makeV9Card({ id: "usdc-circle", score: 90 })] }),
        activeStablecoins: [trackedMeta("usdc-circle")],
      }),
    );

    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]).toMatchObject({
      id: "usdc-circle",
      marketCapUsd: 1_000,
      statuses: {
        dependency: {
          kind: "resolved-none",
          available: true,
        },
        mintAuthority: {
          kind: "issuer-or-backend-mint",
          available: true,
        },
      },
    });
    expect(model.sourceDepthProgress).toMatchObject({
      totalCount: 1,
      atTargetCount: 1,
      exactTwoCount: 0,
      belowTargetCount: 0,
    });
    expect(model.pricingSources).toEqual([
      { name: "CoinGecko", count: 1 },
      { name: "DefiLlama", count: 1 },
      { name: "Pyth", count: 1 },
    ]);
    expect(model.unavailableFeatures).toEqual([]);
    expect(model.isInitialDataLoading).toBe(false);
    expect(model.isStablecoinDataUnavailable).toBe(false);
    expect(model.dataUpdatedAt).toBe(7);
    expect(model.staleQueries.every((query) => query.hasData)).toBe(true);
  });

  it("uses reviewed FreezeWatch status before stale V9 freeze exposure", () => {
    const model = buildCoverageMatrixModel(
      makeMatrixInput({
        stablecoins: {
          peggedAssets: [
            { id: "lisusd-lista", name: "Lista USD", symbol: "LISUSD", circulating: { peggedUSD: 1_000 } },
          ],
        },
        reportCards: makeReportCardsV9Response({
          cards: [
            makeV9Card({
              id: "lisusd-lista",
              accessPosture: { ...makeV9Card().accessPosture, freezeExposure: "possible" },
            }),
          ],
        }),
        activeStablecoins: [trackedMeta("lisusd-lista")],
      }),
    );

    expect(model.rows[0]?.statuses.blacklist.kind).toBe("no");
  });

  it("uses published V9 live-reserve provenance for the reserve headline", () => {
    const model = buildCoverageMatrixModel(
      makeMatrixInput({
        reportCards: makeReportCardsV9Response({
          cards: [makeV9Card({ id: "usdt-tether", backingFromLiveReserves: true })],
        }),
        activeStablecoins: [trackedMeta("usdt-tether")],
      }),
    );

    expect(model.rows[0]?.statuses.reserves.kind).toBe("live");
    expect(model.featureSummaries.find((summary) => summary.feature.key === "reserves")).toMatchObject({
      availableCount: 1,
      totalCount: 1,
      coveragePct: 100,
    });
  });

  it("classifies dependency-map roles from live report-card graph edges", () => {
    const model = buildCoverageMatrixModel(
      makeMatrixInput({
        reportCards: makeReportCardsV9Response({
          cards: [
            makeV9Card({ id: "usdc-circle", score: 90 }),
            makeV9Card({
              id: "dai-makerdao",
              score: 80,
              dependencies: {
                serial: [{ upstreamAssetId: "usdc-circle", score: 90, blocked: false }],
                basket: [],
                cycleBlocked: false,
                reasonCodes: [],
              },
            }),
            makeV9Card({
              id: "usdt-tether",
              score: 85,
              dependencies: {
                serial: [],
                basket: [{ upstreamAssetId: "untracked", weight: 0.2, score: null, boundedUnknown: true }],
                cycleBlocked: false,
                reasonCodes: [],
              },
            }),
          ],
        }),
        activeStablecoins: [trackedMeta("usdc-circle"), trackedMeta("dai-makerdao"), trackedMeta("usdt-tether")],
      }),
    );

    const dependencyKindById = new Map(model.rows.map((row) => [row.id, row.statuses.dependency.kind]));
    expect(dependencyKindById.get("usdc-circle")).toBe("upstream");
    expect(dependencyKindById.get("dai-makerdao")).toBe("dependent");
    expect(dependencyKindById.get("usdt-tether")).toBe("unmapped-gap");
  });

  it("passes client mint-authority summaries into coverage rows", () => {
    const model = buildCoverageMatrixModel(
      makeMatrixInput({
        stablecoins: {
          peggedAssets: [
            { id: "usdc-circle", name: "USD Coin", symbol: "USDC", circulating: { peggedUSD: 1_000 } },
          ],
        },
        activeStablecoins: [
          {
            ...trackedMeta("usdc-circle"),
            mintAuthoritySummary: {
              mintPath: "issuer-direct-mint",
              authorityPosture: "concentrated-admin",
              confidence: "verified",
            },
          },
        ],
      }),
    );

    expect(model.rows[0].statuses.mintAuthority).toMatchObject({
      kind: "issuer-or-backend-mint",
      available: true,
    });
  });

  it("selects widest/narrowest/mostConcentrated features consistently with featureSummaries", () => {
    const model = buildCoverageMatrixModel(
      makeMatrixInput({
        stablecoins: {
          peggedAssets: [
            { id: "usdc-circle", name: "USD Coin", symbol: "USDC", circulating: { peggedUSD: 5_000 } },
            { id: "dai-makerdao", name: "Dai", symbol: "DAI", circulating: { peggedUSD: 2_000 } },
            { id: "usdt-tether", name: "Tether", symbol: "USDT", circulating: { peggedUSD: 1_000 } },
          ],
        },
        pegSummary: {
          summary: {},
          coins: [
            { id: "usdc-circle", consensusSources: ["CoinGecko", "DefiLlama", "Pyth"], priceConfidence: "high" },
            { id: "dai-makerdao", consensusSources: ["CoinGecko"], priceConfidence: "low" },
          ],
        },
        dexLiquidity: { "usdc-circle": { coverageClass: "primary" } },
        yieldRankings: { rankings: [{ id: "usdc-circle" }] },
        mintBurnFlows: {
          gauge: {},
          hourly: [],
          coins: [{ stablecoinId: "usdc-circle", coverage: { status: "full" } }],
        },
        reportCards: makeReportCardsV9Response({ cards: [makeV9Card({ id: "usdc-circle", score: 90 })] }),
        activeStablecoins: [trackedMeta("usdc-circle"), trackedMeta("dai-makerdao"), trackedMeta("usdt-tether")],
      }),
    );

    const summaries = model.featureSummaries;
    const knownSummaries = summaries.filter((summary) => summary.coveragePct != null);
    const concentration = (s: (typeof summaries)[number]) => (s.mcapSharePct ?? 0) - (s.coveragePct ?? 0);

    expect(model.widestFeature?.coveragePct).toBe(Math.max(...knownSummaries.map((s) => s.coveragePct ?? 0)));
    expect(model.narrowestFeature?.coveragePct).toBe(Math.min(...knownSummaries.map((s) => s.coveragePct ?? 0)));
    expect(concentration(model.mostConcentratedFeature!)).toBe(Math.max(...summaries.map(concentration)));
  });

  it("marks coins absent from the stablecoins payload as market-cap unavailable, not $0", () => {
    const model = buildCoverageMatrixModel(
      makeMatrixInput({
        stablecoins: { peggedAssets: [{ id: "usdc-circle", circulating: { peggedUSD: 1_000 } }] },
        activeStablecoins: [trackedMeta("usdc-circle"), trackedMeta("dai-makerdao")],
      }),
    );

    expect(model.rows.find((row) => row.id === "usdc-circle")).toMatchObject({
      marketCapUsd: 1_000,
      marketCapAvailable: true,
    });
    expect(model.rows.find((row) => row.id === "dai-makerdao")).toMatchObject({
      marketCapUsd: 0,
      marketCapAvailable: false,
    });
  });

  it("marks redemption coverage as Data n/a when the redemption feed is unavailable", () => {
    const error = new Error("redemption feed unavailable");
    const model = buildCoverageMatrixModel(
      makeMatrixInput({
        stablecoins: {
          peggedAssets: [
            { id: "usdc-circle", name: "USD Coin", symbol: "USDC", circulating: { peggedUSD: 1_000 } },
          ],
        },
        reportCards: { cards: [], dependencyGraph: { edges: [] } },
        errors: { redemptionBackstops: error },
        activeStablecoins: [trackedMeta("usdc-circle")],
      }),
    );

    expect(model.rows[0].statuses.redemption).toMatchObject({
      kind: "data-unavailable",
      label: "Data n/a",
      available: false,
    });
    expect(model.unavailableFeatures).toEqual(["redemption"]);
    expect(model.featureSummaries.find((summary) => summary.feature.key === "redemption")?.coveragePct).toBeNull();
    expect(model.narrowestFeature?.feature.key).not.toBe("redemption");
    expect(model.isInitialDataLoading).toBe(false);
    expect(model.staleQueries.find((query) => query.preset === "redemptionBackstops")).toMatchObject({
      error,
      hasData: false,
    });
  });

  it("keeps impaired redemption rows out of strong coverage", () => {
    const model = buildCoverageMatrixModel(
      makeMatrixInput({
        stablecoins: {
          peggedAssets: [
            { id: "usdc-circle", name: "USD Coin", symbol: "USDC", circulating: { peggedUSD: 1_000 } },
          ],
        },
        redemptionBackstops: {
          coins: {
            "usdc-circle": {
              stablecoinId: "usdc-circle",
              resolutionState: "resolved",
              routeStatus: "paused",
              routeStatusReason: "Issuer paused primary redemption while reserves are reconciled.",
              routeFamily: "offchain-issuer",
              modelConfidence: "medium",
              capacitySemantics: "immediate-bounded",
              score: 65,
            },
          },
        },
        reportCards: { cards: [], dependencyGraph: { edges: [] } },
        activeStablecoins: [trackedMeta("usdc-circle")],
      }),
    );

    expect(model.rows[0].statuses.redemption).toMatchObject({
      kind: "impaired",
      label: "Impaired",
      available: false,
      detail: "Issuer paused primary redemption while reserves are reconciled.",
    });
    const redemptionSummary = model.featureSummaries.find((summary) => summary.feature.key === "redemption");
    expect(redemptionSummary).toMatchObject({
      availableCount: 0,
      coveragePct: 0,
    });
    expect(redemptionSummary?.breakdown.find((item) => item.key === "impaired")).toMatchObject({
      label: "impaired",
      count: 1,
    });
  });

  it("excludes unavailable and NAV-only prices from source-depth denominators", () => {
    const coin = trackedMeta("usdc-circle");
    const stablecoins = { peggedAssets: [{ id: coin.id, circulating: { peggedUSD: 1_000 } }] };

    const unavailable = buildCoverageMatrixModel(
      makeMatrixInput({ stablecoins, errors: { pegSummary: new Error("price outage") }, activeStablecoins: [coin] }),
    );
    expect(unavailable.sourceDepthProgress).toMatchObject({
      totalCount: 0,
      atTargetCount: 0,
      belowTargetCount: 0,
      atTargetPct: null,
      atTargetMcapPct: null,
    });

    const navOnly = buildCoverageMatrixModel(
      makeMatrixInput({
        stablecoins,
        activeStablecoins: [{ ...coin, flags: { ...coin.flags, navToken: true } }],
      }),
    );
    expect(navOnly.sourceDepthProgress).toMatchObject({
      totalCount: 0,
      belowTargetCount: 0,
      atTargetPct: null,
      atTargetMcapPct: null,
    });
  });
});
