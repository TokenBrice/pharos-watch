import { describe, expect, it } from "vitest";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { computeRedemptionPayloadFingerprint } from "@shared/lib/report-cards-fixed-input-identity";
import { buildSafetyScoreV9InputIdentity } from "@shared/lib/safety-score-v9-input-identity";
import {
  buildNativeV9InputCacheEntry,
  computeNativeDexLiquidityPayloadFingerprint,
  deriveNativeV9BaseInputGenerationId,
  NATIVE_V9_INPUT_CACHE_KEY,
  NativeSafetyScoreV9InputSchema,
  normalizeNativeV9Input,
  parseNativeV9InputCacheArtifact,
  parseNativeV9InputCacheValue,
  type NativeSafetyScoreV9Input,
} from "../safety-score-v9-native-input";
import {
  createReportCardsFixedInput,
  parseReportCardsFixedInputCacheValue,
  buildReportCardsFixedInputCacheEntry,
} from "../report-cards-fixed-input";

const CLOCK_SEC = 1_783_891_200;
const DEX_UPDATED_AT = 1_783_891_100;
const SOURCE_GENERATION = `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:${CLOCK_SEC}`;
const ACTIVE_IDS = ACTIVE_STABLECOINS.map((coin) => coin.id);

function nativeDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const dexLiqMap = {
    "usdc-circle": { updatedAt: DEX_UPDATED_AT },
    "usdt-tether": { updatedAt: DEX_UPDATED_AT },
  };
  return {
    schemaVersion: 4,
    captureKind: "native-v9-inputs",
    capturedAt: new Date(CLOCK_SEC * 1_000).toISOString(),
    sourceGeneration: SOURCE_GENERATION,
    registryRevision: `sha256:${"c".repeat(64)}`,
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    clockSec: CLOCK_SEC,
    updatedAt: CLOCK_SEC,
    liquidityStale: false,
    redemptionStale: true,
    inputFreshness: {
      dexLiquidity: { updatedAt: DEX_UPDATED_AT, ageSeconds: CLOCK_SEC - DEX_UPDATED_AT, stale: false },
      redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
    },
    v9PublicationInputHealth: {
      dex: { state: "current", generationId: `dex-liquidity-${DEX_UPDATED_AT}`, updatedAtSec: DEX_UPDATED_AT },
      redemption: { state: "not-applicable", generationId: null, updatedAtSec: null },
      liveReserves: { state: "available" },
    },
    pegDataById: {},
    activeDepegPeakBpsById: {},
    redemptionBackstopMap: {},
    liveReserveMap: {},
    liveReserveProvenanceMap: {},
    chainCirculatingById: {
      "usdc-circle": { ethereum: { current: 1_000 } },
    },
    aggregateCirculatingById: {},
    dexDeploymentSupplyCoverageById: {},
    liveToFallbackCoins: [],
    activeAssetIds: ["usdc-circle", "usdt-tether"],
    dexGenerationId: `dex-liquidity-${DEX_UPDATED_AT}`,
    redemptionGenerationId: "redemption-backstops-unavailable",
    dexPayloadFingerprint: computeNativeDexLiquidityPayloadFingerprint(
      dexLiqMap,
      `dex-liquidity-${DEX_UPDATED_AT}`,
    ),
    redemptionPayloadFingerprint: computeRedemptionPayloadFingerprint({}, "redemption-backstops-unavailable"),
    registryFingerprint: "c".repeat(64),
    inputMethodologyVersions: {
      safetyScore: SAFETY_SCORE_METHODOLOGY_VERSION,
      dexLiquidity: ["1.0"],
      pegScore: [],
      redemptionBackstop: [],
    },
    dexLiqMap,
    ...overrides,
  };
}

function nativeInput(overrides: Record<string, unknown> = {}): NativeSafetyScoreV9Input {
  return normalizeNativeV9Input(nativeDraft(overrides));
}

describe("native Safety Score V9 input", () => {
  it("round-trips through the v2 envelope with a verified payload checksum", async () => {
    const input = nativeInput();
    const identity = buildSafetyScoreV9InputIdentity({
      methodologyVersion: input.methodologyVersion,
      baseInputGenerationId: input.baseInputGenerationId,
      publicationGenerationId: input.sourceGeneration,
    });

    const entry = await buildNativeV9InputCacheEntry(input, identity);
    expect(entry.key).toBe(NATIVE_V9_INPUT_CACHE_KEY);
    const envelope = JSON.parse(entry.value) as Record<string, unknown>;
    expect(envelope.schemaVersion).toBe(2);
    expect(envelope.safetyScoreIdentity).toEqual(identity);

    const artifact = await parseNativeV9InputCacheArtifact(entry.value);
    expect(artifact.safetyScoreIdentity).toEqual(identity);
    expect(artifact.input).toEqual(input);
    expect(await parseNativeV9InputCacheValue(entry.value)).toEqual(input);

    // The stored checksum must actually gate the payload.
    const tampered = JSON.stringify({ ...envelope, payloadSha256: "f".repeat(64) });
    await expect(parseNativeV9InputCacheValue(tampered)).rejects.toThrow(/checksum mismatch/);
  });

  it("refuses a v1 envelope on the native parser", async () => {
    await expect(
      parseNativeV9InputCacheValue(
        JSON.stringify({
          schemaVersion: 1,
          kind: "report-cards-fixed-input-exact",
          encoding: "gzip-base64",
          sourceGeneration: SOURCE_GENERATION,
          payloadSha256: "a".repeat(64),
          uncompressedBytes: 1,
          payload: "x",
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects every field the native capture drops", () => {
    for (const dropped of [
      { bluechipMap: {} },
      { resolvedBlacklistStatuses: { "usdc-circle": true } },
      { collateralDriftCoins: [] },
    ]) {
      expect(() => normalizeNativeV9Input(nativeDraft(dropped))).toThrow(/Malformed native V9 input/);
    }
  });

  it("rejects a chain circulating bucket field outside `current`", () => {
    expect(() =>
      normalizeNativeV9Input(
        nativeDraft({
          chainCirculatingById: {
            "usdc-circle": { ethereum: { current: 1_000, circulatingPrevDay: 900 } },
          },
        }),
      ),
    ).toThrow(/Malformed native V9 input/);
  });

  it("rejects a v3 DEX row field outside the native exit-route projection", () => {
    expect(() =>
      normalizeNativeV9Input(
        nativeDraft({
          dexLiqMap: {
            "usdc-circle": { updatedAt: DEX_UPDATED_AT, liquidityScore: 80 },
            "usdt-tether": { updatedAt: DEX_UPDATED_AT },
          },
        }),
      ),
    ).toThrow(/Malformed native V9 input/);
  });

  it("derives one generation id per payload regardless of field order", () => {
    const input = nativeInput();
    expect(input.baseInputGenerationId).toMatch(/^report-cards-input:v1:[a-f0-9]{64}$/);

    const permuted = Object.fromEntries(
      Object.entries(input as unknown as Record<string, unknown>).reverse(),
    ) as unknown as NativeSafetyScoreV9Input;
    expect(deriveNativeV9BaseInputGenerationId(permuted)).toBe(input.baseInputGenerationId);

    const reorderedMaps = {
      ...input,
      chainCirculatingById: { ...input.chainCirculatingById, "usdt-tether": {} },
    };
    expect(deriveNativeV9BaseInputGenerationId(reorderedMaps)).not.toBe(input.baseInputGenerationId);
  });

  it("ignores V9 enrichment fields so an enriched capture keeps its base identity", () => {
    const input = nativeInput();
    expect(
      deriveNativeV9BaseInputGenerationId({
        ...input,
        evidenceJournalById: { "usdc-circle": [] },
        pegProvenanceById: {},
      }),
    ).toBe(input.baseInputGenerationId);
  });

  it("changes the generation id when a consumed value changes", () => {
    const input = nativeInput();
    const moved = nativeInput({
      chainCirculatingById: { "usdc-circle": { ethereum: { current: 1_001 } } },
    });
    expect(moved.baseInputGenerationId).not.toBe(input.baseInputGenerationId);
  });

  it("keeps the schema strict about its own version and capture kind", () => {
    expect(NativeSafetyScoreV9InputSchema.safeParse(nativeDraft({ schemaVersion: 3 })).success).toBe(false);
    expect(
      NativeSafetyScoreV9InputSchema.safeParse(nativeDraft({ captureKind: "exact-publication-inputs" })).success,
    ).toBe(false);
  });

  it("still parses a retained v3 capture through the legacy parser", async () => {
    const legacy = createReportCardsFixedInput({
      captureKind: "exact-publication-inputs",
      capturedAt: new Date(CLOCK_SEC * 1_000).toISOString(),
      sourceGeneration: SOURCE_GENERATION,
      dexGenerationId: `dex-liquidity-${DEX_UPDATED_AT}`,
      redemptionGenerationId: "redemption-backstops-unavailable",
      registryRevision: `sha256:${"c".repeat(64)}`,
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      clockSec: CLOCK_SEC,
      updatedAt: CLOCK_SEC,
      liquidityStale: false,
      redemptionStale: true,
      inputFreshness: {
        dexLiquidity: { updatedAt: DEX_UPDATED_AT, ageSeconds: CLOCK_SEC - DEX_UPDATED_AT, stale: false },
        redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
      },
      pegDataById: {},
      activeDepegPeakBpsById: {},
      dexLiqMap: Object.fromEntries(
        ACTIVE_IDS.map((id) => [
          id,
          {
            liquidityScore: null,
            concentrationHhi: null,
            poolCount: 0,
            chainCount: 0,
            methodologyVersion: "1.0",
            updatedAt: DEX_UPDATED_AT,
          },
        ]),
      ),
      redemptionBackstopMap: {},
      bluechipMap: {},
      resolvedBlacklistStatuses: Object.fromEntries(ACTIVE_IDS.map((id) => [id, false])),
      liveReserveMap: {},
      liveReserveProvenanceMap: {},
      chainCirculatingById: {},
      liveToFallbackCoins: [],
      dexDeploymentSupplyCoverageById: {},
      collateralDriftCoins: [],
    });
    const entry = await buildReportCardsFixedInputCacheEntry(legacy);

    const parsed = await parseReportCardsFixedInputCacheValue(entry.value);
    expect(parsed.schemaVersion).toBe(3);
    expect(parsed.baseInputGenerationId).toMatch(/^report-cards-input:v1:[a-f0-9]{64}$/);
  });
});
