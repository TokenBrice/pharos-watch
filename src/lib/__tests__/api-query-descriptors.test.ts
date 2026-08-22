import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FRONTEND_API_QUERY_DESCRIPTORS, type FrontendApiQueryDescriptorRegistry } from "../api-query-descriptors";
import { type FrontendAnyApiQueryDescriptor } from "../api-query-contract";
import { resolveSchemaLike } from "@shared/lib/schema-like";
import {
  StabilityIndexLightResponseSchema,
  STABILITY_INDEX_QUERY_DESCRIPTOR,
} from "../api-query-domains/stability-light";
import { STABILITY_INDEX_DETAIL_QUERY_DESCRIPTOR } from "../api-query-domains/stability-detail";
import { makeReportCardsV9Response } from "@/test/fixtures/safety-score-v9";

const EXPECTED_RESPONSE_MODES: {
  [TKey in keyof FrontendApiQueryDescriptorRegistry]: "plain" | "meta" | "static";
} = {
  stablecoins: "meta",
  chains: "meta",
  bluechipRatings: "meta",
  dailyDigest: "plain",
  dexLiquidity: "meta",
  dexLiquidityHistory: "plain",
  digestArchive: "meta",
  digestSnapshot: "static",
  health: "plain",
  blacklistSummary: "meta",
  blacklistEvents: "meta",
  mintBurnFlows: "meta",
  mintBurnFlowsCoin: "meta",
  mintBurnEvents: "meta",
  pegSummary: "meta",
  reportCardsV9: "meta",
  depegResolver: "meta",
  depegResolverReview: "meta",
  redemptionBackstops: "meta",
  safetyScoreHistory: "meta",
  stablecoinCharts: "plain",
  nonUsdShare: "plain",
  stabilityIndex: "meta",
  stabilityIndexDetail: "meta",
  usdsStatus: "plain",
  telegramPulse: "plain",
  yieldHistory: "meta",
  yieldRankings: "meta",
  yieldRankingsSummary: "meta",
  yieldAdapterManifest: "static",
  stressSignals: "meta",
  stressSignalDetail: "meta",
  supplyHistory: "plain",
};

const PARAMETERIZED_ARGS: Record<string, unknown[]> = {
  dexLiquidityHistory: ["usdc-circle", 90],
  digestSnapshot: ["2026-07-09"],
  blacklistEvents: [{ queryKey: ["blacklist-events", "all"], path: "/api/blacklist?limit=50" }],
  mintBurnFlows: [24],
  mintBurnFlowsCoin: ["usdc-circle", 168],
  mintBurnEvents: ["usdc-circle", { scope: "counted", limit: 25 }],
  safetyScoreHistory: ["usdc-circle", 3650],
  yieldHistory: ["usdc-circle", 90, "best", null],
  stressSignalDetail: ["usdc-circle", 30],
  supplyHistory: ["usdc-circle", 1825],
};

type DescriptorBuilder = (...args: unknown[]) => FrontendAnyApiQueryDescriptor;

function resolveEntry(entry: unknown, key: string): FrontendAnyApiQueryDescriptor {
  if (typeof entry !== "function") return entry as FrontendAnyApiQueryDescriptor;
  const args = PARAMETERIZED_ARGS[key];
  expect(args, `${key} needs parity-test arguments`).toBeDefined();
  return (entry as DescriptorBuilder)(...args);
}

describe("frontend API query descriptors", () => {
  it("keeps the summary projection isolated from the detailed rankings cache", () => {
    expect(FRONTEND_API_QUERY_DESCRIPTORS.yieldRankings).toMatchObject({
      queryKey: ["yield-rankings"],
      path: "/api/yield-rankings",
    });
    expect(FRONTEND_API_QUERY_DESCRIPTORS.yieldRankingsSummary).toMatchObject({
      queryKey: ["yield-rankings", "summary"],
      path: "/api/yield-rankings?projection=summary",
    });
    expect(FRONTEND_API_QUERY_DESCRIPTORS.yieldRankingsSummary.queryKey).not.toEqual(
      FRONTEND_API_QUERY_DESCRIPTORS.yieldRankings.queryKey,
    );
  });

  it("treats the build-derived yield adapter manifest as static", () => {
    expect(FRONTEND_API_QUERY_DESCRIPTORS.yieldAdapterManifest).toMatchObject({
      queryKey: ["yield-adapter-manifest"],
      path: "/api/yield-adapter-manifest",
      responseMode: "static",
    });
    expect(FRONTEND_API_QUERY_DESCRIPTORS.yieldAdapterManifest).not.toHaveProperty("producerIntervalMs");
    expect(FRONTEND_API_QUERY_DESCRIPTORS.yieldAdapterManifest).not.toHaveProperty("metaMaxAgeSec");
  });

  it("aligns PSI and DEWS detail descriptors with their producer intervals", () => {
    expect(STABILITY_INDEX_QUERY_DESCRIPTOR.producerIntervalMs).toBe(
      STABILITY_INDEX_DETAIL_QUERY_DESCRIPTOR.producerIntervalMs,
    );

    const stressDetail = resolveEntry(
      FRONTEND_API_QUERY_DESCRIPTORS.stressSignalDetail,
      "stressSignalDetail",
    );
    if (!("producerIntervalMs" in stressDetail)) throw new Error("stressSignalDetail must be a polling descriptor");
    expect(stressDetail.producerIntervalMs).toBe(
      FRONTEND_API_QUERY_DESCRIPTORS.stressSignals.producerIntervalMs,
    );
  });

  it("pins every descriptor's response mode", () => {
    for (const key of Object.keys(FRONTEND_API_QUERY_DESCRIPTORS)) {
      const runtimeEntry = FRONTEND_API_QUERY_DESCRIPTORS[key as keyof FrontendApiQueryDescriptorRegistry];
      const runtimeDescriptor = resolveEntry(runtimeEntry, key);

      expect(runtimeDescriptor.responseMode, key).toBe(
        EXPECTED_RESPONSE_MODES[key as keyof typeof EXPECTED_RESPONSE_MODES],
      );
    }
  });

  it("keeps non-global schemas lazy and caches each loader promise", async () => {
    for (const key of Object.keys(FRONTEND_API_QUERY_DESCRIPTORS)) {
      const entry = FRONTEND_API_QUERY_DESCRIPTORS[key as keyof FrontendApiQueryDescriptorRegistry];
      const descriptor = resolveEntry(entry, key);
      if (key === "stabilityIndex") {
        expect(descriptor.schema).toBe(StabilityIndexLightResponseSchema);
        continue;
      }

      expect(typeof descriptor.schema, key).toBe("function");
      const first = (descriptor.schema as () => Promise<unknown>)();
      const second = (descriptor.schema as () => Promise<unknown>)();
      expect(second, `${key} loader cache`).toBe(first);
      await expect(resolveSchemaLike(descriptor.schema)).resolves.toEqual(
        expect.objectContaining({ safeParse: expect.any(Function) }),
      );
    }
  }, 30_000);

  it("accepts only report-v5 at the live V9 reader boundary", async () => {
    const schema = await resolveSchemaLike(FRONTEND_API_QUERY_DESCRIPTORS.reportCardsV9.schema);
    if (schema === undefined) throw new Error("Expected a V9 report-card response schema");
    const reportV5 = makeReportCardsV9Response();

    expect(schema.safeParse(reportV5).success).toBe(true);
    expect(schema.safeParse({ ...reportV5, schemaVersion: 4 }).success).toBe(false);
  });

  it("validates only global PSI display fields and preserves the full payload", () => {
    const payload = {
      current: {
        score: 8,
        band: "STEADY",
        avg24h: 7.5,
        avg24hBand: "STEADY",
        computedAt: 1_700_000_000,
        components: { severity: 1, breadth: 2, stressBreadth: 3, trend: -1 },
        methodologyVersion: "v1",
        contributors: [{ extra: "preserved" }],
      },
      history: [{ date: 1_699_900_000, score: 7, band: "STEADY", methodologyVersion: "v1" }],
      methodology: { version: "v1", extra: true },
    };

    const parsed = StabilityIndexLightResponseSchema.safeParse(payload);
    expect(parsed).toEqual({ success: true, data: payload });
    expect(STABILITY_INDEX_QUERY_DESCRIPTOR.schema).toBe(StabilityIndexLightResponseSchema);
  });

  it("rejects malformed PSI fields used by the root shell", () => {
    const parsed = StabilityIndexLightResponseSchema.safeParse({
      current: {
        score: 8,
        band: "STEADY",
        computedAt: 1_700_000_000,
        components: { severity: "bad", breadth: 2, trend: -1 },
      },
      history: [],
    });

    expect(parsed).toEqual({
      success: false,
      error: { issues: [{ path: ["current", "components", "severity"], message: "Expected finite number" }] },
    });
  });

  it("keeps the root PSI hook outside umbrella registries and full-schema loaders", () => {
    const hookSource = readFileSync("src/hooks/use-stability-index-light.ts", "utf8");
    const lightContractSource = readFileSync("src/lib/api-query-domains/stability-light.ts", "utf8");

    expect(hookSource).not.toMatch(/api-hooks|api-query-(?:runtime-)?registry/);
    expect(lightContractSource).not.toMatch(/from ["']zod|import\(["']@shared\/types\/stability["']\)/);
  });
});
