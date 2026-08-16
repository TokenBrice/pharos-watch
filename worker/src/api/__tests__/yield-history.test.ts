import { afterEach, describe, expect, it, vi } from "vitest";
import { mockD1 as baseMockD1 } from "../../test-helpers/__shared/mock-d1";
import { makeYieldHistoryRow } from "../../test-helpers/__shared/fixtures";
import { registerStablecoinParameterContract } from "../../test-helpers/__shared/endpoint-contracts";
import { handleYieldHistory } from "../yield-history";
import { YIELD_HISTORY_OWNERSHIP_HANDOFFS } from "../../lib/yield-history-ownership-handoffs";
import { YieldHistoryResponseSchema, type YieldHistoryResponse } from "@shared/types/yield";
import {
  SOURCE_RISK_GOLDEN_PUBLICATION_GENERATION_ID,
  SOURCE_RISK_GOLDEN_UPDATED_AT,
  buildSourceRiskGoldenFixture,
  getSourceRiskGoldenRow,
} from "@shared/lib/__tests__/yield-source-risk-golden-fixtures";
import { YIELD_HISTORY_MAX_DAYS } from "@shared/lib/yield-history-policy";

function mockD1(
  tables: Parameters<typeof baseMockD1>[0] = [],
  options: Parameters<typeof baseMockD1>[1] = {},
) {
  return baseMockD1([
    ...tables,
    { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
    { match: "SELECT MAX(started_at) as started_at FROM cron_runs WHERE job = ? AND status = 'ok'", rows: [], first: null },
  ], options);
}

const v748HistoryPayload = {
  current: {
    date: 1_778_679_602,
    apy: 4.72,
    apyBase: 4.72,
    apyReward: null,
    exchangeRate: null,
    sourceTvlUsd: 268_000_000,
    warningSignals: [],
    sourceKey: "protocol-api:aave-v3:usdc",
    yieldSource: "Aave V3 USDC",
    yieldSourceUrl: "https://aave.com/",
    yieldType: "lending-opportunity",
    dataSource: "protocol-api",
    isBest: true,
    sourceSwitch: false,
  },
  history: [
    {
      date: 1_778_679_602,
      apy: 4.72,
      apyBase: 4.72,
      apyReward: null,
      exchangeRate: null,
      sourceTvlUsd: 268_000_000,
      warningSignals: [],
      sourceKey: "protocol-api:aave-v3:usdc",
      yieldSource: "Aave V3 USDC",
      yieldSourceUrl: "https://aave.com/",
      yieldType: "lending-opportunity",
      dataSource: "protocol-api",
      isBest: true,
      sourceSwitch: false,
    },
  ],
  methodology: {
    version: "7.48",
    versionLabel: "v7.48",
    currentVersion: "7.48",
    currentVersionLabel: "v7.48",
    changelogPath: "/methodology/yield-changelog/",
    asOf: 1_778_679_602,
    isCurrent: true,
  },
} satisfies YieldHistoryResponse;

describe("handleYieldHistory", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const row = makeYieldHistoryRow();

  it("returns 200 with history envelope", async () => {
    const db = mockD1([{ match: "yield_history", rows: [row] }]);
    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=usdt-tether"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      current: Record<string, unknown> | null;
      history: Array<Record<string, unknown>>;
      methodology: Record<string, unknown>;
    };
    expect(body.history).toHaveLength(1);
    expect(body.current).toEqual(body.history[0]);
    expect(body.history[0]).toHaveProperty("date");
    expect(body.history[0]).toHaveProperty("apy");
    expect(body.history[0]).toHaveProperty("apyBase");
    expect(body.history[0]).toHaveProperty("apyReward");
    expect(body.history[0]).toHaveProperty("exchangeRate");
    expect(body.history[0]).toHaveProperty("sourceTvlUsd");
    expect(body.history[0]).toHaveProperty("sourceKey");
    expect(body.history[0]).toHaveProperty("yieldSourceUrl");
    expect(body.history[0]).toHaveProperty("dataSource");
    expect(body.history[0]).toHaveProperty("isBest");
    expect(body.history[0]).toHaveProperty("sourceSwitch");
    expect(body.methodology).toHaveProperty("version");
  });

  it("falls back to legacy yield_history schema when publish snapshot columns are absent", async () => {
    const db = mockD1([
      { match: "best-window-tiered */", rows: [], throwError: new Error("D1_ERROR: no such column: pys_at_publish") },
      { match: "legacy-schema", rows: [row] },
    ]);

    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=usdt-tether"));
    const body = (await res.json()) as { history: Array<Record<string, unknown>> };

    expect(res.status).toBe(200);
    expect(body.history).toHaveLength(1);
    expect(db.getHistory().some((entry) => entry.sql.includes("legacy-schema"))).toBe(true);
  });

  it("parses a production-shaped v7.48 old history payload through the schema and handler", async () => {
    expect(YieldHistoryResponseSchema.parse(v748HistoryPayload).publication).toBeUndefined();
    expect(YieldHistoryResponseSchema.parse(v748HistoryPayload).history[0]?.sourceRisk).toBeUndefined();

    const db = mockD1([{ match: "yield_history", rows: [row] }]);
    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=usdt-tether"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(() => YieldHistoryResponseSchema.parse(body)).not.toThrow();
    expect((body as YieldHistoryResponse).publication).toBeUndefined();
  });

  it("accepts nullable optional publication and source-risk scaffolding on history payloads", () => {
    const parsed = YieldHistoryResponseSchema.parse({
      ...v748HistoryPayload,
      publication: {
        generationId: null,
        updatedAt: null,
        cutoffAt: null,
        schemaVersion: null,
        status: null,
      },
      current: {
        ...v748HistoryPayload.current,
        publicationGenerationId: null,
        sourceRisk: {
          sourceRiskScore: null,
          sourceRiskPenalty: null,
          sourceDepthRatio: null,
          rewardShare: null,
          sourceAgeSeconds: null,
          observationCount30d: null,
          sourceSwitchCount30d: null,
          deploymentPlace: null,
          venueProtocol: null,
          venueChain: null,
          venueRiskTier: null,
        },
      },
      history: v748HistoryPayload.history.map((point) => ({
        ...point,
        publicationGenerationId: null,
        sourceRisk: {
          sourceRiskScore: null,
          sourceRiskPenalty: null,
          observationCount30d: null,
          sourceSwitchCount30d: null,
          venueRiskTier: "unknown",
          investabilityFlags: [],
        },
      })),
    });

    expect(parsed.publication?.status).toBeNull();
    expect(parsed.current?.publicationGenerationId).toBeNull();
    expect(parsed.history[0]?.sourceRisk?.venueRiskTier).toBe("unknown");
  });

  it("returns 200 with empty history when no data", async () => {
    const db = mockD1([{ match: "yield_history", rows: [] }]);
    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=usdt-tether"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { current: null; history: unknown[] };
    expect(body.current).toBeNull();
    expect(body.history).toEqual([]);
  });

  it("rejects out-of-range day windows instead of clamping them", async () => {
    const db = mockD1([]);
    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=usdt-tether&days=9999"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: `Invalid days: must be between 1 and ${YIELD_HISTORY_MAX_DAYS}`,
    });
  });

  it("maps snake_case to camelCase", async () => {
    const db = mockD1([{ match: "yield_history", rows: [row] }]);
    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=usdt-tether"));
    const body = (await res.json()) as { history: Array<Record<string, unknown>> };
    expect(body.history[0]).not.toHaveProperty("recorded_at");
    expect(body.history[0]).not.toHaveProperty("apy_base");
    expect(body.history[0]).not.toHaveProperty("apy_reward");
    expect(body.history[0]).not.toHaveProperty("exchange_rate");
    expect(body.history[0]).not.toHaveProperty("source_tvl_usd");
  });

  it("supports source-specific history mode", async () => {
    const db = mockD1([{ match: "yield_history", rows: [row] }]);
    const res = await handleYieldHistory(
      db,
      new URL(`https://x/api/yield-history?stablecoin=usdt-tether&sourceKey=${encodeURIComponent("aave-v3:usdt")}`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { history: Array<{ sourceKey: string }> };
    expect(body.history[0]?.sourceKey).toBe("aave-v3:usdt");
  });

  it("filters on-chain bootstrap seed rows from best-mode history", async () => {
    const bootstrapRow = makeYieldHistoryRow({
      apy: 0,
      apy_base: null,
      data_source: "onchain",
      exchange_rate: 1.001,
      recorded_at: 1_771_000_000,
      source_key: "onchain:usdt-tether",
      yield_source: "On-chain seed",
      yield_type: "nav-appreciation",
    });
    const liveRow = makeYieldHistoryRow({
      apy: 4.2,
      apy_base: null,
      data_source: "onchain",
      exchange_rate: 1.005,
      recorded_at: 1_771_086_400,
      source_key: "onchain:usdt-tether",
      yield_source: "On-chain live",
      yield_type: "nav-appreciation",
    });
    const db = mockD1([{ match: "yield_history", rows: [bootstrapRow, liveRow] }]);

    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=usdt-tether"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      current: { apy: number } | null;
      history: Array<{ apy: number }>;
    };
    expect(body.history).toHaveLength(1);
    expect(body.history[0]?.apy).toBe(4.2);
    expect(body.current?.apy).toBe(4.2);
  });

  it("filters on-chain bootstrap seed rows from source-mode history", async () => {
    const bootstrapRow = makeYieldHistoryRow({
      apy: 0,
      apy_base: null,
      data_source: "onchain",
      exchange_rate: 1.001,
      recorded_at: 1_771_000_000,
      source_key: "onchain:usdt-tether",
      yield_source: "On-chain seed",
      yield_type: "nav-appreciation",
    });
    const liveRow = makeYieldHistoryRow({
      apy: 4.2,
      apy_base: null,
      data_source: "onchain",
      exchange_rate: 1.005,
      recorded_at: 1_771_086_400,
      source_key: "onchain:usdt-tether",
      yield_source: "On-chain live",
      yield_type: "nav-appreciation",
    });
    const db = mockD1([{ match: "yield_history", rows: [bootstrapRow, liveRow] }]);

    const res = await handleYieldHistory(
      db,
      new URL("https://x/api/yield-history?stablecoin=usdt-tether&sourceKey=onchain%3Ausdt-tether"),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      current: { apy: number } | null;
      history: Array<{ apy: number }>;
    };
    expect(body.history).toHaveLength(1);
    expect(body.history[0]?.apy).toBe(4.2);
    expect(body.current?.apy).toBe(4.2);
  });

  it("marks the transition from legacy-best to a source-aware row as a source switch", async () => {
    const legacyRow = makeYieldHistoryRow({
      source_key: "legacy-best",
      recorded_at: 1_771_000_000,
      data_source: "price-derived",
      yield_source: null,
      yield_type: null,
    });
    const newRow = makeYieldHistoryRow({
      source_key: "rate-derived",
      recorded_at: 1_771_086_400,
      data_source: "rate-derived",
      yield_source: "T-bill proxy",
      yield_type: "nav-appreciation",
    });
    const db = mockD1([{ match: "yield_history", rows: [legacyRow, newRow] }]);

    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=usdt-tether"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { history: Array<{ sourceKey: string; sourceSwitch: boolean }> };
    expect(body.history[0]).toMatchObject({ sourceKey: "legacy-best", sourceSwitch: false });
    expect(body.history[1]).toMatchObject({ sourceKey: "rate-derived", sourceSwitch: true });
  });

  it("normalizes legacy LUSD deterministic keys in best-mode history without a synthetic switch", async () => {
    const legacyRow = makeYieldHistoryRow({
      source_key: "bprotocol-lqty-only",
      recorded_at: 1_773_960_283,
      data_source: "onchain",
      yield_source: "B.Protocol Stability Pool (LQTY only)",
      yield_type: "lending-vault",
    });
    const normalizedRow = makeYieldHistoryRow({
      source_key: "onchain:lusd-liquity",
      recorded_at: 1_773_962_101,
      data_source: "onchain",
      yield_source: "B.Protocol Stability Pool (LQTY only)",
      yield_type: "lending-vault",
    });
    const db = mockD1([{ match: "yield_history", rows: [legacyRow, normalizedRow] }]);

    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=lusd-liquity"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { history: Array<{ sourceKey: string; sourceSwitch: boolean }> };
    expect(body.history[0]).toMatchObject({ sourceKey: "onchain:lusd-liquity", sourceSwitch: false });
    expect(body.history[1]).toMatchObject({ sourceKey: "onchain:lusd-liquity", sourceSwitch: false });
  });

  it("falls back to an empty warning list when warning_signals is malformed JSON", async () => {
    const malformedRow = makeYieldHistoryRow({ warning_signals: "not-json" });
    const db = mockD1([{ match: "yield_history", rows: [malformedRow] }]);

    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=usdt-tether"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { history: Array<{ warningSignals: string[] }> };
    expect(body.history[0]?.warningSignals).toEqual([]);
  });

  it("filters misattributed parent wrapper history after tracked-child ownership handoff", async () => {
    const wrapperRow = makeYieldHistoryRow({
      source_key: "66985a81-9c51-46ca-9977-42b4fe7bc6df",
      data_source: "defillama",
      yield_source: "Ethena staking (sUSDe)",
      yield_type: "nav-appreciation",
    });
    const db = mockD1([{ match: "yield_history", rows: [wrapperRow] }]);

    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=usde-ethena"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { current: null; history: unknown[] };
    expect(body.current).toBeNull();
    expect(body.history).toEqual([]);
  });

  it("suppresses all tracked parent handoff source keys in source mode", async () => {
    expect(YIELD_HISTORY_OWNERSHIP_HANDOFFS["avusd-avant"]).toEqual(
      expect.arrayContaining([
        "onchain:avusd-avant",
        "2fe112ff-95a5-4ba0-8ee3-a741e6a8f7c9",
        "c74227a1-e738-4021-bbe1-13363815aecb",
      ]),
    );
    expect(YIELD_HISTORY_OWNERSHIP_HANDOFFS["reusd-re-protocol"]).toEqual([
      "protocol-api:re-protocol-reusde",
    ]);

    for (const [stablecoinId, sourceKeys] of Object.entries(YIELD_HISTORY_OWNERSHIP_HANDOFFS)) {
      for (const sourceKey of sourceKeys) {
        const suppressedRow = makeYieldHistoryRow({
          source_key: sourceKey,
          yield_source: `${stablecoinId}:${sourceKey}`,
        });
        const db = mockD1([{ match: "yield_history", rows: [suppressedRow] }]);

        const res = await handleYieldHistory(
          db,
          new URL(`https://x/api/yield-history?stablecoin=${stablecoinId}&sourceKey=${encodeURIComponent(sourceKey)}`),
        );

        expect(res.status, `${stablecoinId}:${sourceKey}`).toBe(200);
        const body = (await res.json()) as { current: null; history: unknown[] };
        expect(body.current, `${stablecoinId}:${sourceKey}`).toBeNull();
        expect(body.history, `${stablecoinId}:${sourceKey}`).toEqual([]);
      }
    }
  });

  it("uses the hourly yield freshness budget for history responses", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 3_500;
    const historyRow = makeYieldHistoryRow({ recorded_at: updatedAt });
    const db = mockD1([{ match: "yield_history", rows: [historyRow] }]);

    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=usdt-tether"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Warning")).toBeNull();
    expect(res.headers.get("X-Data-Age")).toBe("3500");
  });

  it("falls back to the latest successful yield cron timestamp when the yield-rankings cache is malformed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-28T12:00:00Z"));
    const nowSec = Math.floor(Date.now() / 1000);
    const latestSuccessfulCronAt = nowSec - 1_800;

    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["yield-rankings"],
        rows: [],
        first: { value: "{bad-json", updated_at: nowSec - 60 },
      },
      {
        match: "MAX(started_at) as started_at FROM cron_runs",
        rows: [],
        first: { started_at: latestSuccessfulCronAt },
      },
      { match: "yield_history", rows: [row] },
    ]);

    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=usdt-tether"));
    expect(res.status).toBe(200);

    const historyQuery = db.getHistory().find((entry) => entry.sql.includes("FROM yield_history h"));
    expect(historyQuery?.binds).toContain(latestSuccessfulCronAt);
  });

  it("uses published generation metadata to cap history and expose row generation IDs", async () => {
    const publishedAt = SOURCE_RISK_GOLDEN_UPDATED_AT;
    const generatedRow = {
      ...makeYieldHistoryRow({ recorded_at: publishedAt }),
      publication_generation_id: SOURCE_RISK_GOLDEN_PUBLICATION_GENERATION_ID,
    };
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["yield-rankings"],
        rows: [
          {
            key: "yield-rankings",
            value: JSON.stringify({
              updatedAt: publishedAt,
              publication: {
                generationId: SOURCE_RISK_GOLDEN_PUBLICATION_GENERATION_ID,
                updatedAt: publishedAt,
                cutoffAt: publishedAt,
                schemaVersion: 1,
                status: "published",
              },
              rankings: [],
            }),
            updated_at: publishedAt,
          },
        ],
      },
      { match: "yield_history", rows: [generatedRow] },
    ]);

    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=usdt-tether"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      publication?: { generationId?: string; status?: string };
      history: Array<{ publicationGenerationId?: string | null }>;
    };
    expect(body.publication).toMatchObject({
      generationId: SOURCE_RISK_GOLDEN_PUBLICATION_GENERATION_ID,
      status: "published",
    });
    expect(body.history[0]?.publicationGenerationId).toBe(SOURCE_RISK_GOLDEN_PUBLICATION_GENERATION_ID);

    const historyQuery = db.getHistory().find((entry) => entry.sql.includes("FROM yield_history h"));
    expect(historyQuery?.sql).toContain("publication_state = 'published'");
    expect(historyQuery?.binds).toContain(publishedAt);
  });

  it("attaches nested sourceRisk to generation-matched history points from the rankings cache", async () => {
    const publishedAt = SOURCE_RISK_GOLDEN_UPDATED_AT;
    const rewardHeavyRisk = buildSourceRiskGoldenFixture("reward-heavy", {
      sourceRiskScore: 72,
      sourceDepthRatio: 0.18,
      sourceAgeSeconds: 420,
      observationCount30d: 18,
      sourceSwitchCount30d: 1,
      deploymentPlace: "lending-market",
      venueProtocol: "aave-v3",
      venueChain: "ethereum",
      venueRiskTier: "low",
      venueRiskScores: {
        audits: 2,
        centralization: 2.5,
        fundsManagement: 2,
        liquidity: 1.5,
        operational: 1,
      },
      venueRiskWeighted: 2.05,
      venueRiskConfidence: "partial",
      dependencyConcentration: {
        ecosystem: "Sky",
        severity: "medium",
        note: "Funded debt is concentrated behind one governance ecosystem.",
        reviewedAt: "2026-05-15",
      },
      trancheSide: "senior",
      trancheSafetyScore: 76,
      trancheSafetyPenalty: 4,
      underlyingSafetyScore: 80,
      marketCoverageRatio: 1.12,
      marketMinCoverageRatio: 1,
      marketUtilizationRatio: 0.82,
      marketUtilizationLimitRatio: 0.9,
      marketDrawdownRatio: 0.01,
      marketTotalDrawdowns: 1,
      marketStatus: "protected",
      marketTvlUsd: 25_000_000,
      trancheTvlUsd: 8_000_000,
      trancheShareTokenAddress: "0xshare",
      trancheDepositTokenAddress: "0xdeposit",
      withdrawalDelaySeconds: 86_400,
      kycRequired: false,
      accessRestricted: true,
    });
    const generatedRow = {
      ...makeYieldHistoryRow({ recorded_at: publishedAt, source_key: "aave-v3:usdt" }),
      publication_generation_id: SOURCE_RISK_GOLDEN_PUBLICATION_GENERATION_ID,
    };
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["yield-rankings"],
        rows: [
          {
            key: "yield-rankings",
            value: JSON.stringify({
              updatedAt: publishedAt,
              publication: {
                generationId: SOURCE_RISK_GOLDEN_PUBLICATION_GENERATION_ID,
                updatedAt: publishedAt,
                cutoffAt: publishedAt,
                schemaVersion: 1,
                status: "published",
              },
              rankings: [
                {
                  id: "usdt-tether",
                  publicationGenerationId: SOURCE_RISK_GOLDEN_PUBLICATION_GENERATION_ID,
                  provenance: { sourceKey: "aave-v3:usdt" },
                  sourceRisk: rewardHeavyRisk,
                },
              ],
            }),
            updated_at: publishedAt,
          },
        ],
      },
      { match: "yield_history", rows: [generatedRow] },
    ]);

    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=usdt-tether"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as YieldHistoryResponse;
    expect(body.current?.sourceRisk).toMatchObject({
      sourceRiskPenalty: rewardHeavyRisk.sourceRiskPenalty,
      sourceRiskScore: 72,
      sourceDepthRatio: 0.18,
      rewardShare: rewardHeavyRisk.rewardShare,
      sourceAgeSeconds: 420,
      observationCount30d: 18,
      sourceSwitchCount30d: 1,
      deploymentPlace: "lending-market",
      venueProtocol: "aave-v3",
      venueChain: "ethereum",
      venueRiskTier: "low",
      venueRiskScores: {
        audits: 2,
        centralization: 2.5,
        fundsManagement: 2,
        liquidity: 1.5,
        operational: 1,
      },
      venueRiskWeighted: 2.05,
      venueRiskConfidence: "partial",
      dependencyConcentration: {
        ecosystem: "Sky",
        severity: "medium",
        note: "Funded debt is concentrated behind one governance ecosystem.",
        reviewedAt: "2026-05-15",
      },
      trancheSide: "senior",
      trancheSafetyScore: 76,
      trancheSafetyPenalty: 4,
      underlyingSafetyScore: 80,
      marketCoverageRatio: 1.12,
      marketMinCoverageRatio: 1,
      marketUtilizationRatio: 0.82,
      marketUtilizationLimitRatio: 0.9,
      marketDrawdownRatio: 0.01,
      marketTotalDrawdowns: 1,
      marketStatus: "protected",
      marketTvlUsd: 25_000_000,
      trancheTvlUsd: 8_000_000,
      trancheShareTokenAddress: "0xshare",
      trancheDepositTokenAddress: "0xdeposit",
      withdrawalDelaySeconds: 86_400,
      kycRequired: false,
      accessRestricted: true,
      investabilityFlags: ["reward-heavy"],
    });
    expect(body.history[0]?.sourceRisk).toEqual(body.current?.sourceRisk);
    expect((body.history[0] as unknown as Record<string, unknown> | undefined)?.sourceRiskPenalty).toBeUndefined();
    expect(() => YieldHistoryResponseSchema.parse(body)).not.toThrow();
  });

  it("drops malformed nested source-risk fields without dropping valid siblings", async () => {
    const publishedAt = SOURCE_RISK_GOLDEN_UPDATED_AT;
    const generatedRow = {
      ...makeYieldHistoryRow({ recorded_at: publishedAt, source_key: "aave-v3:usdt" }),
      publication_generation_id: SOURCE_RISK_GOLDEN_PUBLICATION_GENERATION_ID,
    };
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["yield-rankings"],
        rows: [
          {
            key: "yield-rankings",
            value: JSON.stringify({
              updatedAt: publishedAt,
              publication: {
                generationId: SOURCE_RISK_GOLDEN_PUBLICATION_GENERATION_ID,
                updatedAt: publishedAt,
                cutoffAt: publishedAt,
                schemaVersion: 1,
                status: "published",
              },
              rankings: [
                {
                  id: "usdt-tether",
                  publicationGenerationId: SOURCE_RISK_GOLDEN_PUBLICATION_GENERATION_ID,
                  provenance: { sourceKey: "aave-v3:usdt" },
                  sourceRisk: {
                    sourceRiskPenalty: 1.2,
                    venueRiskScores: { audits: 2, centralization: "bad" },
                    venueRiskWeighted: 2.4,
                    dependencyConcentration: {
                      ecosystem: "Sky",
                      severity: "unsupported",
                      note: "Malformed legacy shorthand should not poison the whole object.",
                      reviewedAt: "2026-05-15",
                    },
                  },
                },
              ],
            }),
            updated_at: publishedAt,
          },
        ],
      },
      { match: "yield_history", rows: [generatedRow] },
    ]);

    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=usdt-tether"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as YieldHistoryResponse;
    expect(body.current?.sourceRisk).toEqual({
      sourceRiskPenalty: 1.2,
      venueRiskWeighted: 2.4,
    });
    expect(() => YieldHistoryResponseSchema.parse(body)).not.toThrow();
  });

  it("ignores flattened source-risk shorthand when enriching history from rankings cache", async () => {
    const publishedAt = SOURCE_RISK_GOLDEN_UPDATED_AT;
    const rewardHeavyRow = getSourceRiskGoldenRow("reward-heavy");
    const generatedRow = {
      ...makeYieldHistoryRow({ recorded_at: publishedAt, source_key: "aave-v3:usdt" }),
      publication_generation_id: SOURCE_RISK_GOLDEN_PUBLICATION_GENERATION_ID,
    };
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["yield-rankings"],
        rows: [
          {
            key: "yield-rankings",
            value: JSON.stringify({
              updatedAt: publishedAt,
              publication: {
                generationId: SOURCE_RISK_GOLDEN_PUBLICATION_GENERATION_ID,
                updatedAt: publishedAt,
                cutoffAt: publishedAt,
                schemaVersion: 1,
                status: "published",
              },
              rankings: [
                {
                  id: "usdt-tether",
                  publicationGenerationId: SOURCE_RISK_GOLDEN_PUBLICATION_GENERATION_ID,
                  provenance: { sourceKey: "aave-v3:usdt" },
                  sourceRiskPenalty: rewardHeavyRow.expectedDerivedPenalty,
                },
              ],
            }),
            updated_at: publishedAt,
          },
        ],
      },
      { match: "yield_history", rows: [generatedRow] },
    ]);

    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=usdt-tether"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as YieldHistoryResponse;
    expect(body.current?.sourceRisk).toBeUndefined();
    expect((body.history[0] as unknown as Record<string, unknown> | undefined)?.sourceRiskPenalty).toBeUndefined();
  });

  it("keeps legacy history behavior when the rankings cache has no generation metadata", async () => {
    const publishedAt = 1_774_526_400;
    const legacyRow = makeYieldHistoryRow({ recorded_at: publishedAt });
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["yield-rankings"],
        rows: [
          {
            key: "yield-rankings",
            value: JSON.stringify({ updatedAt: publishedAt, rankings: [] }),
            updated_at: publishedAt,
          },
        ],
      },
      { match: "yield_history", rows: [legacyRow] },
    ]);

    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=usdt-tether"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { publication?: unknown; history: unknown[] };
    expect(body.publication).toBeUndefined();
    expect(body.history).toHaveLength(1);

    const historyQuery = db.getHistory().find((entry) => entry.sql.includes("FROM yield_history h"));
    expect(historyQuery?.sql).toContain("publication_generation_id IS NULL OR publication_state = 'published'");
    expect(historyQuery?.binds).toContain(publishedAt);
  });

  it("exposes pysAtPublish / safetyAtPublish / varianceAtPublish snapshot fields on history points", async () => {
    const pysInputsAtPublish = {
      schemaVersion: 1,
      methodologyVersion: "8.31",
      apy30d: 7.2,
      safetyScore: 81,
      varianceScore: 0.18,
      benchmarkRate: 4.2,
      sourceRiskPenalty: 1.15,
      scalingFactor: 16,
      scoreQualification: "rated",
      benchmarkKey: "USD",
      evidenceClass: "direct-onchain",
    };
    const snapshotRow = makeYieldHistoryRow({
      pys_at_publish: 73.5,
      safety_at_publish: 81,
      variance_at_publish: 0.18,
      pys_inputs_at_publish: JSON.stringify(pysInputsAtPublish),
    });
    const db = mockD1([{ match: "yield_history", rows: [snapshotRow] }]);

    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=usdt-tether"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      history: Array<{
        pysAtPublish?: number | null;
        safetyAtPublish?: number | null;
        varianceAtPublish?: number | null;
        pysInputsAtPublish?: typeof pysInputsAtPublish | null;
        pysReproducibility?: string;
      }>;
    };
    expect(body.history[0]?.pysAtPublish).toBe(73.5);
    expect(body.history[0]?.safetyAtPublish).toBe(81);
    expect(body.history[0]?.varianceAtPublish).toBe(0.18);
    expect(body.history[0]?.pysInputsAtPublish).toEqual(pysInputsAtPublish);
    expect(body.history[0]?.pysReproducibility).toBe("exact");
  });

  it("returns nullable snapshot fields when not yet populated", async () => {
    const legacyRow = makeYieldHistoryRow({
      pys_at_publish: null,
      safety_at_publish: null,
      variance_at_publish: null,
    });
    const db = mockD1([{ match: "yield_history", rows: [legacyRow] }]);

    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=usdt-tether"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      history: Array<{
        pysAtPublish?: number | null;
        safetyAtPublish?: number | null;
        varianceAtPublish?: number | null;
        pysInputsAtPublish?: unknown;
        pysReproducibility?: string;
      }>;
    };
    expect(body.history[0]?.pysAtPublish).toBeNull();
    expect(body.history[0]?.safetyAtPublish).toBeNull();
    expect(body.history[0]?.varianceAtPublish).toBeNull();
    expect(body.history[0]?.pysInputsAtPublish).toBeNull();
    expect(body.history[0]?.pysReproducibility).toBe("legacy-partial");
  });

  it("surfaces a warning and uses cache metadata when the cron timestamp lookup fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-28T12:00:00Z"));
    const nowSec = Math.floor(Date.now() / 1000);

    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["yield-rankings"],
        rows: [],
        first: { value: "{bad-json", updated_at: nowSec - 60 },
      },
      {
        match: "MAX(started_at) as started_at FROM cron_runs",
        rows: [],
        throwError: new Error("cron lookup failed"),
      },
      { match: "yield_history", rows: [row] },
    ]);

    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=usdt-tether"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { warning?: string };
    expect(body.warning).toContain("freshness lookup failed");
    expect(() => YieldHistoryResponseSchema.parse(body)).not.toThrow();

    const historyQuery = db.getHistory().find((entry) => entry.sql.includes("FROM yield_history h"));
    expect(historyQuery?.binds).toContain(nowSec - 60);
  });
});

registerStablecoinParameterContract({
  name: "yield history",
  path: "/api/yield-history",
  invoke: handleYieldHistory,
});
