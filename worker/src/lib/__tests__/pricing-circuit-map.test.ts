import { describe, it, expect } from "vitest";
import { PRICING_SOURCE_REGISTRY } from "@shared/lib/pricing-source-registry";
import { CIRCUIT_SOURCE } from "../constants";
import { PRICING_SOURCE_TO_CIRCUIT } from "../pricing-circuit-map";

describe("PRICING_SOURCE_TO_CIRCUIT contract", () => {
  it("every registry source has an entry in PRICING_SOURCE_TO_CIRCUIT", () => {
    for (const entry of PRICING_SOURCE_REGISTRY) {
      expect(PRICING_SOURCE_TO_CIRCUIT).toHaveProperty(entry.key);
    }
  });

  it("every mapped breaker value exists in CIRCUIT_SOURCE", () => {
    const circuitValues = new Set(Object.values(CIRCUIT_SOURCE));
    for (const value of Object.values(PRICING_SOURCE_TO_CIRCUIT)) {
      if (value == null) continue;
      expect(circuitValues).toContain(value);
    }
  });

  it("PRICING_SOURCE_TO_CIRCUIT has no keys missing from registry", () => {
    const registryKeys = new Set(PRICING_SOURCE_REGISTRY.map((e) => e.key));
    for (const key of Object.keys(PRICING_SOURCE_TO_CIRCUIT)) {
      expect(registryKeys).toContain(key);
    }
  });
});
