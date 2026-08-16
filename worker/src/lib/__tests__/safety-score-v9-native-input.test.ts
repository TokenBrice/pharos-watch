import { describe, expect, it } from "vitest";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/safety-score";
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

    const corruptLength = JSON.stringify({ ...envelope, uncompressedBytes: 1 });
    await expect(parseNativeV9InputCacheValue(corruptLength)).rejects.toThrow(
      "exceeds its declared uncompressed byte length",
    );
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
  describe("fail-closed consistency guards", () => {
    // The native capture is the deterministic-replay contract's payload: every
    // guard below is the only thing standing between a mis-assembled capture
    // and a published score derived from it. They were the module's largest
    // untested surface after the Wave-1 cutover.

    it("rejects duplicate active asset identities", () => {
      expect(() =>
        normalizeNativeV9Input(nativeDraft({ activeAssetIds: ["usdc-circle", "usdc-circle", "usdt-tether"] })),
      ).toThrow(/active asset identities contain duplicates/);
    });

    it("rejects a NAV price row on a non-NAV asset", () => {
      expect(() =>
        normalizeNativeV9Input(
          nativeDraft({
            navPriceById: {
              "usdc-circle": {
                priceUsd: 1,
                sourceId: "test",
                observedAtSec: CLOCK_SEC,
                confidence: "high",
              },
            },
          }),
        ),
      ).toThrow(/NAV price rows target non-NAV assets/);
    });

    it("rejects a DEX row set that does not cover exactly the active assets", () => {
      expect(() =>
        normalizeNativeV9Input(
          nativeDraft({
            dexLiqMap: { "usdc-circle": { updatedAt: DEX_UPDATED_AT } },
            dexPayloadFingerprint: computeNativeDexLiquidityPayloadFingerprint(
              { "usdc-circle": { updatedAt: DEX_UPDATED_AT } },
              `dex-liquidity-${DEX_UPDATED_AT}`,
            ),
          }),
        ),
      ).toThrow(/DEX active rows mismatch/);
    });

    it("rejects a DEX payload fingerprint that does not match the payload", () => {
      expect(() =>
        normalizeNativeV9Input(nativeDraft({ dexPayloadFingerprint: "a".repeat(64) })),
      ).toThrow(/DEX payload fingerprint .* does not match payload/);
    });

    it("rejects a redemption payload fingerprint that does not match the payload", () => {
      expect(() =>
        normalizeNativeV9Input(nativeDraft({ redemptionPayloadFingerprint: "a".repeat(64) })),
      ).toThrow(/redemption payload fingerprint .* does not match payload/);
    });

    it("rejects an evidence journal record newer than the scoring clock", () => {
      expect(() =>
        normalizeNativeV9Input(
          nativeDraft({
            evidenceJournalById: {
              "usdc-circle": [
                {
                  assetId: "usdc-circle",
                  taskKey: "reserve-review",
                  completedAtSec: CLOCK_SEC + 60,
                  evidenceRefIds: [],
                },
              ],
            },
          }),
        ),
      ).toThrow(/Malformed native V9 input|later than the scoring clock/);
    });

    it("rejects an evidence journal keyed to an inactive asset", () => {
      expect(() =>
        normalizeNativeV9Input(nativeDraft({ evidenceJournalById: { "not-tracked": [] } })),
      ).toThrow(/Evidence journal targets inactive asset/);
    });

    it("rejects a supply-attribution journal keyed to an inactive asset", () => {
      expect(() =>
        normalizeNativeV9Input(nativeDraft({ supplyAttributionJournalById: { "not-tracked": [] } })),
      ).toThrow(/Supply attribution journal targets inactive asset/);
    });

    it("rejects a base generation id that does not match the payload", () => {
      const draft = nativeDraft();
      expect(() =>
        normalizeNativeV9Input({ ...draft, baseInputGenerationId: "report-cards-input:v1:" + "0".repeat(64) }),
      ).toThrow(/Malformed native V9 input|does not match payload/);
    });

    it("rejects DEX rows whose timestamps disagree with the DEX freshness generation", () => {
      const dexLiqMap = {
        "usdc-circle": { updatedAt: DEX_UPDATED_AT },
        "usdt-tether": { updatedAt: DEX_UPDATED_AT - 10 },
      };
      expect(() =>
        normalizeNativeV9Input(
          nativeDraft({
            dexLiqMap,
            dexPayloadFingerprint: computeNativeDexLiquidityPayloadFingerprint(
              dexLiqMap,
              `dex-liquidity-${DEX_UPDATED_AT}`,
            ),
          }),
        ),
      ).toThrow(/DEX rows do not match the DEX freshness generation/);
    });

    it("rejects a DEX generation id that does not match the active-row generation", () => {
      expect(() =>
        normalizeNativeV9Input(
          nativeDraft({
            dexGenerationId: `dex-liquidity-${DEX_UPDATED_AT - 1}`,
            dexPayloadFingerprint: computeNativeDexLiquidityPayloadFingerprint(
              { "usdc-circle": { updatedAt: DEX_UPDATED_AT }, "usdt-tether": { updatedAt: DEX_UPDATED_AT } },
              `dex-liquidity-${DEX_UPDATED_AT - 1}`,
            ),
          }),
        ),
      ).toThrow(/DEX generation .* does not match active-row generation/);
    });

    it("rejects an empty redemption map that claims current freshness", () => {
      expect(() =>
        normalizeNativeV9Input(
          nativeDraft({
            redemptionStale: false,
            inputFreshness: {
              dexLiquidity: { updatedAt: DEX_UPDATED_AT, ageSeconds: CLOCK_SEC - DEX_UPDATED_AT, stale: false },
              redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: false },
            },
          }),
        ),
      ).toThrow(/no redemption rows but marks redemption freshness as current/);
    });

    it("rejects a redemption generation id that is not producer-bound", () => {
      expect(() =>
        normalizeNativeV9Input(
          nativeDraft({
            redemptionGenerationId: "whatever",
            redemptionPayloadFingerprint: computeRedemptionPayloadFingerprint({}, "whatever"),
          }),
        ),
      ).toThrow(/redemption generation .* is not producer-bound/);
    });

    it("rejects top-level freshness flags that disagree with their lanes", () => {
      expect(() => normalizeNativeV9Input(nativeDraft({ liquidityStale: true }))).toThrow(
        /top-level freshness flags do not match lane freshness/,
      );
    });

    it("rejects a producer timestamp later than the scoring clock", () => {
      const updatedAt = CLOCK_SEC + 60;
      const dexLiqMap = {
        "usdc-circle": { updatedAt },
        "usdt-tether": { updatedAt },
      };
      expect(() =>
        normalizeNativeV9Input(
          nativeDraft({
            dexLiqMap,
            dexGenerationId: `dex-liquidity-${updatedAt}`,
            dexPayloadFingerprint: computeNativeDexLiquidityPayloadFingerprint(
              dexLiqMap,
              `dex-liquidity-${updatedAt}`,
            ),
            inputFreshness: {
              dexLiquidity: { updatedAt, ageSeconds: CLOCK_SEC - updatedAt, stale: false },
              redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
            },
          }),
        ),
      ).toThrow(/Malformed native V9 input|later than scoring clock/);
    });

    it("rejects a lane age that does not match the clock-derived age", () => {
      expect(() =>
        normalizeNativeV9Input(
          nativeDraft({
            inputFreshness: {
              dexLiquidity: { updatedAt: DEX_UPDATED_AT, ageSeconds: 1, stale: false },
              redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
            },
          }),
        ),
      ).toThrow(/does not match clock-derived age/);
    });

    it("rejects supply attribution that targets an inactive asset", () => {
      expect(() =>
        normalizeNativeV9Input(
          nativeDraft({
            safetyScoreV9SupplyAttributionById: {
              "not-tracked": {
                model: "canonical-lock-mint-partition-v1",
                observedAtSec: CLOCK_SEC,
                currentSupplyUsdByChain: { ethereum: 1 },
              },
            },
          }),
        ),
      ).toThrow(/Malformed native V9 input|targets inactive asset/);
    });
  });
});
