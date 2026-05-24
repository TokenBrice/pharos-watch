import { describe, expect, it } from "vitest";
import {
  getProviderIdForCapacityModelKind,
  getRedemptionBackstopProviderDefinition,
  inferProviderCapacityConfidence,
  inferProviderCapacitySemantics,
  REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS,
  REDEMPTION_BACKSTOP_PROVIDER_IDS,
} from "../redemption-backstop-providers";

describe("redemption backstop provider definitions", () => {
  it("defines every provider ID emitted by redemption backstop sync", () => {
    expect(Object.keys(REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS).sort()).toEqual([
      "fixed-usd-model",
      "reserve-sync-fallback",
      "reserve-sync-metadata",
      "supply-full-model",
      "supply-ratio-model",
      "sync-error",
    ]);
  });

  it("maps capacity model kinds to emitted provider IDs", () => {
    expect(getProviderIdForCapacityModelKind("supply-full")).toBe(
      REDEMPTION_BACKSTOP_PROVIDER_IDS.SUPPLY_FULL_MODEL,
    );
    expect(getProviderIdForCapacityModelKind("supply-ratio")).toBe(
      REDEMPTION_BACKSTOP_PROVIDER_IDS.SUPPLY_RATIO_MODEL,
    );
    expect(getProviderIdForCapacityModelKind("fixed-usd")).toBe(
      REDEMPTION_BACKSTOP_PROVIDER_IDS.FIXED_USD_MODEL,
    );
    expect(getProviderIdForCapacityModelKind("reserve-sync-metadata")).toBe(
      REDEMPTION_BACKSTOP_PROVIDER_IDS.RESERVE_SYNC_METADATA,
    );
  });

  it("captures provider source mode, provenance, confidence, and severe-depeg metadata", () => {
    expect(REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS["supply-full-model"]).toMatchObject({
      capacitySource: "supply-full",
      defaultSourceMode: "estimated",
      provenanceClass: "static-supply-model",
      defaultCapacityConfidence: "heuristic",
      defaultCapacitySemantics: "eventual-only",
      severeDepegScoreability: "not-scoreable",
    });
    expect(REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS["reserve-sync-metadata"]).toMatchObject({
      capacitySource: "live-reserve-metadata",
      defaultSourceMode: "dynamic",
      provenanceClass: "live-reserve-adapter",
      defaultCapacityConfidence: "dynamic",
      defaultCapacitySemantics: "immediate-bounded",
      severeDepegScoreability: "requires-strong-live-direct-route",
    });
    expect(REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS["fixed-usd-model"]).toMatchObject({
      capacitySource: "fixed-usd",
      defaultSourceMode: "static",
      provenanceClass: "reviewed-config-fallback",
      defaultCapacityConfidence: "documented-bound",
      defaultCapacitySemantics: "immediate-bounded",
      severeDepegScoreability: "not-scoreable",
    });
    expect(REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS["sync-error"]).toMatchObject({
      capability: "failure-sentinel",
      capacitySource: "none",
      defaultSourceMode: "static",
      provenanceClass: "runtime-error",
    });
  });

  it("does not assign live-only capacity confidence to static providers by default", () => {
    for (const providerId of [
      "supply-full-model",
      "supply-ratio-model",
      "fixed-usd-model",
      "reserve-sync-fallback",
      "sync-error",
    ] as const) {
      expect(REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS[providerId].defaultCapacityConfidence).not.toMatch(/^live-/);
    }
  });

  it("preserves legacy readback confidence inference by provider/source mode", () => {
    expect(
      inferProviderCapacityConfidence({
        provider: "reserve-sync-metadata",
        sourceMode: "dynamic",
      }),
    ).toBe("dynamic");
    expect(
      inferProviderCapacityConfidence({
        provider: "reserve-sync-metadata",
        sourceMode: "estimated",
      }),
    ).toBe("heuristic");
    expect(
      inferProviderCapacityConfidence({
        provider: "supply-full-model",
        sourceMode: "dynamic",
      }),
    ).toBe("heuristic");
    expect(
      inferProviderCapacityConfidence({
        provider: "unknown-provider",
        sourceMode: "dynamic",
      }),
    ).toBe("heuristic");
  });

  it("preserves legacy readback semantics inference by provider", () => {
    expect(inferProviderCapacitySemantics({ provider: "supply-full-model" })).toBe("eventual-only");
    expect(inferProviderCapacitySemantics({ provider: "supply-ratio-model" })).toBe("immediate-bounded");
    expect(inferProviderCapacitySemantics({ provider: "fixed-usd-model" })).toBe("immediate-bounded");
    expect(inferProviderCapacitySemantics({ provider: "reserve-sync-metadata" })).toBe("immediate-bounded");
    expect(inferProviderCapacitySemantics({ provider: "unknown-provider" })).toBe("immediate-bounded");
  });

  it("returns null for unknown provider IDs", () => {
    expect(getRedemptionBackstopProviderDefinition("unknown-provider")).toBeNull();
  });
});
