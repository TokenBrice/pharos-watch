import { describe, expect, it } from "vitest";
import {
  getRedemptionBackstopProviderDefinition,
  inferProviderCapacityConfidence,
  inferProviderCapacitySemantics,
  REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS,
} from "../redemption-backstop-providers";

describe("redemption backstop provider definitions", () => {

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

  it("defaults unknown providers to eventual-only capacity semantics", () => {
    expect(inferProviderCapacitySemantics({ provider: "supply-full-model" })).toBe("eventual-only");
    expect(inferProviderCapacitySemantics({ provider: "supply-ratio-model" })).toBe("immediate-bounded");
    expect(inferProviderCapacitySemantics({ provider: "fixed-usd-model" })).toBe("immediate-bounded");
    expect(inferProviderCapacitySemantics({ provider: "reserve-sync-metadata" })).toBe("immediate-bounded");
    expect(inferProviderCapacitySemantics({ provider: "unknown-provider" })).toBe("eventual-only");
  });

  it("returns null for unknown provider IDs", () => {
    expect(getRedemptionBackstopProviderDefinition("unknown-provider")).toBeNull();
  });

  it("provider map entries are keyed by their declared IDs", () => {
    for (const [providerId, definition] of Object.entries(REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS)) {
      expect(definition.id).toBe(providerId);
    }
  });
});
