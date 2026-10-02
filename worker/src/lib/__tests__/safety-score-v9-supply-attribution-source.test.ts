import { describe, expect, it, vi } from "vitest";
import { buildSafetyScoreV9InputIdentity } from "@shared/lib/safety-score-v9-input-identity";
import { buildNativeV9InputCacheEntry } from "../safety-score-v9/native-input";
import {
  buildSafetyScoreV9SupplyAttributionSource,
  parseSafetyScoreV9SupplyAttributionSource,
  serializeSafetyScoreV9SupplyAttributionSource,
} from "../safety-score-v9/supply-attribution-source";
import { createNativeSafetyScoreV9FullRegistryInput } from "./fixtures/safety-score-v9-full-registry-input";
import type * as SupplyAttributionContract from "../safety-score-v9/supply-attribution-contract";

describe("Safety Score V9 supply-attribution source", () => {
  it("projects the exact input to a bounded identity-linked source", async () => {
    const input = createNativeSafetyScoreV9FullRegistryInput();
    const source = buildSafetyScoreV9SupplyAttributionSource(input);
    const value = serializeSafetyScoreV9SupplyAttributionSource(source);
    const parsed = parseSafetyScoreV9SupplyAttributionSource(value);
    const exactEntry = await buildNativeV9InputCacheEntry(
      input,
      buildSafetyScoreV9InputIdentity({
        methodologyVersion: input.methodologyVersion,
        baseInputGenerationId: input.baseInputGenerationId,
        publicationGenerationId: input.sourceGeneration,
      }),
    );

    expect(parsed).toEqual(source);
    expect(parsed).toMatchObject({
      baseInputGenerationId: input.baseInputGenerationId,
      sourceGeneration: input.sourceGeneration,
      registryFingerprint: input.registryFingerprint,
      clockSec: input.clockSec,
    });
    expect(Object.keys(parsed.aggregateCirculatingById).sort()).toEqual(
      parsed.activeAssetIds.filter(
        (assetId) => input.aggregateCirculatingById[assetId] !== undefined,
      ).sort(),
    );
    expect(new TextEncoder().encode(value).byteLength).toBeLessThan(
      exactEntry.uncompressedBytes / 20,
    );
  });

  it("rejects malformed serialized and object source payloads", () => {
    expect(() =>
      parseSafetyScoreV9SupplyAttributionSource("{not-json"),
    ).toThrow("Malformed V9 supply-attribution source");
    expect(() =>
      parseSafetyScoreV9SupplyAttributionSource({
        schemaVersion: 1,
        kind: "safety-score-v9-supply-attribution-source",
      }),
    ).toThrow();
  });

  it.each(["overlapping proof lane", "oversized cohort"])(
    "rejects a reviewed registry with an %s before publishing a source",
    async (failure) => {
      const assetIds = failure === "overlapping proof lane"
        ? ["wm-m0"]
        : Array.from({ length: 100 }, (_, index) => `economic-${index}`);
      vi.resetModules();
      // The cohort is checked during module initialization, so each registry needs a fresh import.
      vi.doMock("../safety-score-v9/supply-attribution-contract", async (importOriginal) => ({
        ...await importOriginal<typeof SupplyAttributionContract>(),
        REVIEWED_ECONOMIC_SUPPLY_PLANS: new Map(assetIds.map(assetId => [assetId, {}])),
      }));
      try {
        await expect(import("../safety-score-v9/supply-attribution-source")).rejects.toThrow(
          "Supply attribution reviewed registry exceeds the bounded cohort or overlaps an existing proof lane",
        );
      } finally {
        vi.doUnmock("../safety-score-v9/supply-attribution-contract");
        vi.resetModules();
      }
    },
  );
});
