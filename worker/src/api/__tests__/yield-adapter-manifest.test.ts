import { describe, expect, it } from "vitest";
import { handleYieldAdapterManifest } from "../yield-adapter-manifest";
import { getRouteMatch } from "../../routes/registry";
import { YIELD_METHODOLOGY_VERSION_LABEL } from "@shared/lib/yield-methodology-version";
import {
  YIELD_ADAPTER_MANIFEST_FAMILY_VALUES,
  type YieldAdapterManifestResponse,
} from "@shared/types/yield";

describe("handleYieldAdapterManifest", () => {
  it("returns 200 JSON with the typed manifest payload", async () => {
    const res = await handleYieldAdapterManifest();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");

    const body = (await res.json()) as YieldAdapterManifestResponse;
    expect(body.methodologyVersion).toBe(YIELD_METHODOLOGY_VERSION_LABEL);
    expect(typeof body.updatedAt).toBe("number");
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.length).toBeGreaterThan(0);
  });

  it("covers every adapter family declared in the static registry", async () => {
    const res = await handleYieldAdapterManifest();
    const body = (await res.json()) as YieldAdapterManifestResponse;
    const observedFamilies = new Set(body.entries.map((entry) => entry.family));

    const expectedFamilies = ["onchain", "defillama", "rate-derived", "price-derived"] as const;
    for (const family of expectedFamilies) {
      expect(observedFamilies.has(family)).toBe(true);
    }

    for (const family of observedFamilies) {
      expect(YIELD_ADAPTER_MANIFEST_FAMILY_VALUES).toContain(family);
    }
  });

  it("stamps the current methodology version on every entry and exposes lifecycle", async () => {
    const res = await handleYieldAdapterManifest();
    const body = (await res.json()) as YieldAdapterManifestResponse;
    const validLifecycles = new Set(["active", "quarantined", "intentional-gap", "experimental"]);
    for (const entry of body.entries) {
      expect(entry.methodologyVersion).toBe(YIELD_METHODOLOGY_VERSION_LABEL);
      expect(entry.coinSymbol).toBeTypeOf("string");
      expect(entry.coinSymbol.length).toBeGreaterThan(0);
      expect(entry.sourceKey.length).toBeGreaterThan(0);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(validLifecycles.has(entry.lifecycle)).toBe(true);
    }
  });

  it("registers /api/yield-adapter-manifest as a public GET route", () => {
    const match = getRouteMatch("/api/yield-adapter-manifest");
    expect(match).not.toBeNull();
    expect(match?.methods).toContain("GET");
    expect(match?.endpoint?.adminRequired).toBe(false);
  });
});
