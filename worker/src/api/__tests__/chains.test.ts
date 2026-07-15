import { describe, it, expect, vi } from "vitest";
import type { FreshnessStatus } from "@shared/lib/status-thresholds";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { buildSafetyScoreV8PublicationIdentity } from "@shared/lib/safety-score-v8-publication";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

// Mock stablecoins to avoid importing full metadata tree
vi.mock("@shared/lib/stablecoins/registry", () => ({
  TRACKED_META_BY_ID: new Map([
    ["usdt-tether", { flags: { backing: "rwa-backed" }, commodityOunces: undefined }],
    ["usdc-circle", { flags: { backing: "rwa-backed" }, commodityOunces: undefined }],
    ["dai-makerdao", { flags: { backing: "crypto-backed" }, commodityOunces: undefined }],
  ]),
  TRACKED_STABLECOINS: [],
  ACTIVE_STABLECOINS: [
    { id: "usdt-tether", flags: { backing: "rwa-backed" }, commodityOunces: undefined },
    { id: "usdc-circle", flags: { backing: "rwa-backed" }, commodityOunces: undefined },
    { id: "dai-makerdao", flags: { backing: "crypto-backed" }, commodityOunces: undefined },
  ],
  ACTIVE_IDS: new Set(["usdt-tether", "usdc-circle", "dai-makerdao"]),
  ACTIVE_META_BY_ID: new Map([
    ["usdt-tether", { flags: { backing: "rwa-backed" }, commodityOunces: undefined }],
    ["usdc-circle", { flags: { backing: "rwa-backed" }, commodityOunces: undefined }],
    ["dai-makerdao", { flags: { backing: "crypto-backed" }, commodityOunces: undefined }],
  ]),
  READABLE_IDS: new Set(["usdt-tether", "usdc-circle", "dai-makerdao"]),
  READABLE_META_BY_ID: new Map([
    ["usdt-tether", { flags: { backing: "rwa-backed" }, commodityOunces: undefined }],
    ["usdc-circle", { flags: { backing: "rwa-backed" }, commodityOunces: undefined }],
    ["dai-makerdao", { flags: { backing: "crypto-backed" }, commodityOunces: undefined }],
  ]),
}));

vi.mock("@shared/lib/stablecoins/aggregate-registry", () => ({
  CORE_AGGREGATE_ACTIVE_IDS: new Set(["usdt-tether", "usdc-circle", "dai-makerdao"]),
  CORE_AGGREGATE_ACTIVE_STABLECOINS: [],
  CORE_AGGREGATE_ACTIVE_META_BY_ID: new Map(),
}));

import { handleChains } from "../chains";

function withPublishedStablecoinDefaults(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const record = payload as { peggedAssets?: unknown };
  if (!Array.isArray(record.peggedAssets)) return payload;

  return {
    ...record,
    peggedAssets: record.peggedAssets.map((asset) => {
      if (!asset || typeof asset !== "object") return asset;
      return {
        pegMechanism: "test-fixture",
        priceSource: "test-fixture",
        chainCirculating: {},
        chains: [],
        ...(asset as Record<string, unknown>),
      };
    }),
  };
}

function freshCache(payload: unknown, ageSeconds = 60, options: { publishedFixture?: boolean } = {}) {
  const value = options.publishedFixture === false ? payload : withPublishedStablecoinDefaults(payload);
  return {
    match: "cache",
    matchBinds: ["stablecoins"],
    rows: [],
    first: {
      key: "stablecoins",
      value: JSON.stringify(value),
      updated_at: Math.floor(Date.now() / 1000) - ageSeconds,
    },
  };
}

function reportCardCache(
  scores: Record<string, { score: number; grade: string }>,
  payloadAgeSeconds = 60,
  rowAgeSeconds = payloadAgeSeconds,
  degradedInputs?: {
    inputsStale: boolean;
    liquidityStale: boolean;
    redemptionStale: boolean;
    staleInputs: string[];
  },
) {
  const nowSec = Math.floor(Date.now() / 1000);
  const publicationGenerationId = `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:${nowSec - payloadAgeSeconds}`;
  const notRatedIds = [...ACTIVE_IDS].filter((id) => !(id in scores));
  return {
    match: "cache",
    matchBinds: ["report_card_cache"],
    rows: [],
    first: {
      key: "report_card_cache",
      value: JSON.stringify({
        methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
        scores,
        updatedAt: nowSec - payloadAgeSeconds,
        safetyScoreIdentity: buildSafetyScoreV8PublicationIdentity({
          methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
          baseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`,
          publicationGenerationId,
        }),
        publicationGenerationId,
        completeness: {
          generationId: publicationGenerationId,
          methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
          expectedCount: ACTIVE_IDS.size,
          scoredCount: Object.keys(scores).length,
          notRatedCount: notRatedIds.length,
          notRatedIds,
        },
        ...(degradedInputs ? { degradedInputs } : {}),
      }),
      updated_at: nowSec - rowAgeSeconds,
    },
  };
}

describe("handleChains", () => {
  it("returns 503 when stablecoins cache is missing", async () => {
    const db = mockD1();
    const response = await handleChains(db);
    expect(response.status).toBe(503);
  });

  it("returns 503 when stablecoins cache does not satisfy the published contract", async () => {
    const payload = {
      peggedAssets: [
        {
          id: "usdt-tether",
          symbol: "USDT",
          name: "Tether",
          price: 1.0,
          pegType: "peggedUSD",
          circulating: { peggedUSD: 100 },
        },
      ],
    };

    const db = mockD1([freshCache(payload, 60, { publishedFixture: false })]);

    const response = await handleChains(db);
    expect(response.status).toBe(503);
  });

  it("returns chains sorted by totalUsd", async () => {
    const payload = {
      peggedAssets: [
        {
          id: "usdt-tether",
          symbol: "USDT",
          name: "Tether",
          price: 1.0,
          pegType: "peggedUSD",
          circulating: { peggedUSD: 500 },
          chainCirculating: {
            ethereum: { current: 300, circulatingPrevDay: 290, circulatingPrevWeek: 280, circulatingPrevMonth: 250 },
            bsc: { current: 200, circulatingPrevDay: 200, circulatingPrevWeek: 200, circulatingPrevMonth: 200 },
          },
        },
        {
          id: "usdc-circle",
          symbol: "USDC",
          name: "USD Coin",
          price: 0.999,
          pegType: "peggedUSD",
          circulating: { peggedUSD: 300 },
          chainCirculating: {
            ethereum: { current: 300, circulatingPrevDay: 300, circulatingPrevWeek: 300, circulatingPrevMonth: 300 },
          },
        },
      ],
    };

    const db = mockD1([
      freshCache(payload),
      reportCardCache({ "usdt-tether": { score: 75, grade: "B" }, "usdc-circle": { score: 88, grade: "A" } }),
    ]);

    const response = await handleChains(db);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      chains: Array<{ id: string; totalUsd: number; healthScore: number | null }>;
      safetyScoreIdentity: { model: string } | null;
      _meta: {
        ageSeconds: number;
        status: FreshnessStatus;
        safetyScoreIdentity: { model: string } | null;
        dependencies: {
          reportCards: {
            status: FreshnessStatus | "unavailable";
          };
        };
      };
    };
    expect(body.chains[0].id).toBe("ethereum");
    expect(body.chains[0].totalUsd).toBe(600);
    expect(body.chains[0].healthScore).toBeTypeOf("number");
    expect(body._meta.status).toBe("fresh");
    expect(body._meta.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(body._meta.dependencies.reportCards.status).toBe("fresh");
    expect(body.safetyScoreIdentity).toMatchObject({ model: "v8" });
    expect(body._meta.safetyScoreIdentity).toEqual(body.safetyScoreIdentity);
    expect(response.headers.get("Warning")).toBeNull();
  });

  it("returns null healthScore when report card cache is missing", async () => {
    const payload = {
      peggedAssets: [
        {
          id: "usdt-tether",
          symbol: "USDT",
          name: "Tether",
          price: 1.0,
          pegType: "peggedUSD",
          circulating: { peggedUSD: 100 },
          chainCirculating: {
            ethereum: { current: 100, circulatingPrevDay: 100, circulatingPrevWeek: 100, circulatingPrevMonth: 100 },
          },
        },
      ],
    };

    const db = mockD1([freshCache(payload)]);
    const response = await handleChains(db);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      chains: Array<{ healthScore: number | null }>;
      _meta: {
        status: FreshnessStatus;
        dependencies: {
          reportCards: {
            status: FreshnessStatus | "unavailable";
            reason?: string | null;
          };
        };
      };
    };
    // No report card cache → quality null → healthScore null
    expect(body.chains[0].healthScore).toBeNull();
    expect(body._meta.status).toBe("degraded");
    expect(body._meta.dependencies.reportCards.status).toBe("unavailable");
    expect(body._meta.dependencies.reportCards.reason).toBe("missing cache");
    expect(response.headers.get("Warning")).toContain("report-card cache missing cache");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects an identity-less compact cache instead of deriving health from it", async () => {
    const payload = {
      peggedAssets: [
        {
          id: "usdt-tether",
          symbol: "USDT",
          name: "Tether",
          price: 1,
          pegType: "peggedUSD",
          circulating: { peggedUSD: 100 },
          chainCirculating: {
            ethereum: { current: 100, circulatingPrevDay: 100, circulatingPrevWeek: 100, circulatingPrevMonth: 100 },
          },
        },
      ],
    };
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      freshCache(payload),
      {
        match: "cache",
        matchBinds: ["report_card_cache"],
        rows: [],
        first: {
          key: "report_card_cache",
          value: JSON.stringify({
            methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
            updatedAt: nowSec - 60,
            scores: { "usdt-tether": { score: 99, grade: "A+" } },
          }),
          updated_at: nowSec - 60,
        },
      },
    ]);

    const response = await handleChains(db);
    const body = (await response.json()) as {
      chains: Array<{ healthScore: number | null }>;
      safetyScoreIdentity: unknown;
      _meta: { dependencies: { reportCards: { status: string; reason: string } } };
    };

    expect(body.chains[0].healthScore).toBeNull();
    expect(body.safetyScoreIdentity).toBeNull();
    expect(body._meta.dependencies.reportCards).toMatchObject({ status: "unavailable", reason: "identity missing" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it.each([
    [
      "a complete V9 compact publication",
      "invalid payload",
      (compact: {
        safetyScoreIdentity: Record<string, unknown>;
        publicationGenerationId: string;
        completeness: { generationId: string; notRatedIds: string[] };
      }) => {
        const v9GenerationId = `safety-score-v9:9.0:${Math.floor(Date.now() / 1000) - 60}`;
        compact.safetyScoreIdentity = {
          model: "v9",
          schemaVersion: 1,
          methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
          policyId: "v9-policy-2026-05",
          policyDigest: "b".repeat(64),
          evaluationBuildDigest: "c".repeat(64),
          baseInputGenerationId: `report-cards-input:v1:${"d".repeat(64)}`,
          publicationGenerationId: v9GenerationId,
        };
        compact.publicationGenerationId = v9GenerationId;
        compact.completeness.generationId = v9GenerationId;
      },
    ],
    [
      "a complete V8 publication from a different evaluation build",
      "identity mismatch",
      (compact: {
        safetyScoreIdentity: Record<string, unknown>;
        publicationGenerationId: string;
        completeness: { generationId: string; notRatedIds: string[] };
      }) => {
        const currentDigest = compact.safetyScoreIdentity.evaluationBuildDigest;
        compact.safetyScoreIdentity.evaluationBuildDigest =
          currentDigest === "b".repeat(64) ? "c".repeat(64) : "b".repeat(64);
      },
    ],
    [
      "a complete-count manifest with a swapped active stablecoin",
      "completeness mismatch",
      (compact: {
        safetyScoreIdentity: Record<string, unknown>;
        publicationGenerationId: string;
        completeness: { generationId: string; notRatedIds: string[] };
      }) => {
        compact.completeness.notRatedIds = ["usdc-circle", "unexpected-stablecoin"];
      },
    ],
  ])("fails closed when the V8 chains release sees %s", async (_label, expectedReason, mutate) => {
    const payload = {
      peggedAssets: [
        {
          id: "usdt-tether",
          symbol: "USDT",
          name: "Tether",
          price: 1,
          pegType: "peggedUSD",
          circulating: { peggedUSD: 100 },
          chainCirculating: {
            ethereum: { current: 100, circulatingPrevDay: 100, circulatingPrevWeek: 100, circulatingPrevMonth: 100 },
          },
        },
      ],
    };
    const cache = reportCardCache({ "usdt-tether": { score: 99, grade: "A+" } });
    const compact = JSON.parse(cache.first.value) as {
      safetyScoreIdentity: Record<string, unknown>;
      publicationGenerationId: string;
      completeness: { generationId: string; notRatedIds: string[] };
    };
    mutate(compact);
    cache.first.value = JSON.stringify(compact);

    const response = await handleChains(mockD1([freshCache(payload), cache]));
    const body = (await response.json()) as {
      chains: Array<{ healthScore: number | null }>;
      safetyScoreIdentity: unknown;
      _meta: { dependencies: { reportCards: { status: string; reason: string } } };
    };

    expect(body.chains[0]?.healthScore).toBeNull();
    expect(body.safetyScoreIdentity).toBeNull();
    expect(body._meta.dependencies.reportCards).toMatchObject({
      status: "unavailable",
      reason: expectedReason,
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("marks the response degraded when the stablecoins snapshot is older than the 1800s chains budget", async () => {
    const payload = {
      peggedAssets: [
        {
          id: "usdt-tether",
          symbol: "USDT",
          name: "Tether",
          price: 1.0,
          pegType: "peggedUSD",
          circulating: { peggedUSD: 100 },
          chainCirculating: {
            ethereum: { current: 100, circulatingPrevDay: 100, circulatingPrevWeek: 100, circulatingPrevMonth: 100 },
          },
        },
      ],
    };

    const db = mockD1([freshCache(payload, 1801), reportCardCache({ "usdt-tether": { score: 75, grade: "B" } })]);

    const response = await handleChains(db);
    const body = (await response.json()) as {
      _meta: { ageSeconds: number; status: FreshnessStatus };
    };

    expect(response.status).toBe(200);
    expect(body._meta.ageSeconds).toBeGreaterThanOrEqual(1801);
    expect(body._meta.status).toBe("degraded");
    expect(response.headers.get("Warning")).toContain("Response is degraded");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("marks the response degraded when the report card cache is stale", async () => {
    const payload = {
      peggedAssets: [
        {
          id: "usdt-tether",
          symbol: "USDT",
          name: "Tether",
          price: 1.0,
          pegType: "peggedUSD",
          circulating: { peggedUSD: 100 },
          chainCirculating: {
            ethereum: { current: 100, circulatingPrevDay: 100, circulatingPrevWeek: 100, circulatingPrevMonth: 100 },
          },
        },
      ],
    };

    const db = mockD1([
      freshCache(payload),
      reportCardCache({ "usdt-tether": { score: 75, grade: "B" } }, 3 * 60 * 60),
    ]);

    const response = await handleChains(db);
    const body = (await response.json()) as {
      chains: Array<{ healthScore: number | null }>;
      _meta: {
        status: FreshnessStatus;
        dependencies: {
          reportCards: {
            ageSeconds?: number | null;
            status: FreshnessStatus | "unavailable";
            reason?: string | null;
          };
        };
      };
    };

    expect(response.status).toBe(200);
    expect(body.chains[0].healthScore).toBeNull();
    expect(body._meta.status).toBe("degraded");
    expect(body._meta.dependencies.reportCards.status).toBe("stale");
    expect(body._meta.dependencies.reportCards.ageSeconds).toBeGreaterThanOrEqual(3 * 60 * 60);
    expect(body._meta.dependencies.reportCards.reason).toBe("stale cache");
    expect(response.headers.get("Warning")).toContain("report-card cache stale cache");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("reports report-card dependency age from the payload snapshot, not the cache-row write time", async () => {
    const payload = {
      peggedAssets: [
        {
          id: "usdt-tether",
          symbol: "USDT",
          name: "Tether",
          price: 1.0,
          pegType: "peggedUSD",
          circulating: { peggedUSD: 100 },
          chainCirculating: {
            ethereum: { current: 100, circulatingPrevDay: 100, circulatingPrevWeek: 100, circulatingPrevMonth: 100 },
          },
        },
      ],
    };

    const db = mockD1([
      freshCache(payload),
      reportCardCache({ "usdt-tether": { score: 75, grade: "B" } }, 3 * 60 * 60, 60),
    ]);

    const response = await handleChains(db);
    const body = (await response.json()) as {
      _meta: {
        dependencies: {
          reportCards: {
            ageSeconds?: number | null;
            status: FreshnessStatus | "unavailable";
          };
        };
      };
    };

    expect(body._meta.dependencies.reportCards.status).toBe("stale");
    expect(body._meta.dependencies.reportCards.ageSeconds).toBeGreaterThanOrEqual(3 * 60 * 60);
  });

  it("marks the report-card dependency degraded when cached scores used stale inputs", async () => {
    const payload = {
      peggedAssets: [
        {
          id: "usdt-tether",
          symbol: "USDT",
          name: "Tether",
          price: 1.0,
          pegType: "peggedUSD",
          circulating: { peggedUSD: 100 },
          chainCirculating: {
            ethereum: { current: 100, circulatingPrevDay: 100, circulatingPrevWeek: 100, circulatingPrevMonth: 100 },
          },
        },
      ],
    };

    const db = mockD1([
      freshCache(payload),
      reportCardCache({ "usdt-tether": { score: 75, grade: "B" } }, 60, 60, {
        inputsStale: true,
        liquidityStale: true,
        redemptionStale: false,
        staleInputs: ["dexLiquidity"],
      }),
    ]);

    const response = await handleChains(db);
    const body = (await response.json()) as {
      chains: Array<{ healthScore: number | null }>;
      _meta: {
        status: FreshnessStatus;
        dependencies: {
          reportCards: {
            status: FreshnessStatus | "unavailable";
            reason?: string | null;
            inputsStale?: boolean;
            staleInputs?: string[];
          };
        };
      };
    };

    expect(response.status).toBe(200);
    expect(body.chains[0].healthScore).toBeTypeOf("number");
    expect(body._meta.status).toBe("degraded");
    expect(body._meta.dependencies.reportCards.status).toBe("degraded");
    expect(body._meta.dependencies.reportCards.reason).toBe("inputs stale");
    expect(body._meta.dependencies.reportCards.inputsStale).toBe(true);
    expect(body._meta.dependencies.reportCards.staleInputs).toEqual(["dexLiquidity"]);
    expect(response.headers.get("Warning")).toContain("report-card cache inputs stale");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("excludes frozen and non-active assets from live chain aggregation", async () => {
    const payload = {
      peggedAssets: [
        {
          id: "usdt-tether",
          symbol: "USDT",
          name: "Tether",
          price: 1.0,
          pegType: "peggedUSD",
          circulating: { peggedUSD: 100 },
          chainCirculating: {
            ethereum: { current: 100, circulatingPrevDay: 100, circulatingPrevWeek: 100, circulatingPrevMonth: 100 },
          },
        },
        {
          id: "frozen-archive",
          symbol: "FRZ",
          name: "Frozen Archive",
          price: 1.0,
          pegType: "peggedUSD",
          frozen: true,
          circulating: { peggedUSD: 900 },
          chainCirculating: {
            bsc: { current: 900, circulatingPrevDay: 900, circulatingPrevWeek: 900, circulatingPrevMonth: 900 },
          },
        },
      ],
    };

    const db = mockD1([
      freshCache(payload),
      reportCardCache({
        "usdt-tether": { score: 75, grade: "B" },
        "frozen-archive": { score: 5, grade: "F" },
      }),
    ]);

    const response = await handleChains(db);
    const body = (await response.json()) as {
      chains: Array<{ id: string; totalUsd: number }>;
      globalTotalUsd: number;
      chainAttributedTotalUsd: number;
    };

    expect(response.status).toBe(200);
    expect(body.chains).toHaveLength(1);
    expect(body.chains[0]).toMatchObject({ id: "ethereum", totalUsd: 100 });
    expect(body.globalTotalUsd).toBe(100);
    expect(body.chainAttributedTotalUsd).toBe(100);
  });
});
