import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { describe, expect, it } from "vitest";
import { handleYieldAdapterManifest } from "../yield-adapter-manifest";
import { getRouteMatch } from "../../routes/registry";
import { YIELD_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/yield-methodology";
import {
  RATE_DERIVED_CONFIGS,
  YIELD_POOL_MAP,
  YIELD_WEIGHTED_POOL_GROUPS,
} from "../../lib/yield-config/yield-config";
import {
  YIELD_ADAPTER_MANIFEST_FAMILY_VALUES,
  YieldAdapterManifestResponseSchema,
  type YieldAdapterManifestResponse,
} from "@shared/types/yield";

describe("handleYieldAdapterManifest", () => {
  it("returns 200 JSON with the typed manifest payload", async () => {
    const res = await handleYieldAdapterManifest();
    expect(res.headers.get("Content-Type")).toContain("application/json");

    const body = (await readJsonResponse(res, 200)) as YieldAdapterManifestResponse;
    expect(() => YieldAdapterManifestResponseSchema.parse(body)).not.toThrow();
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
      if (entry.sourceKey != null) {
        expect(entry.sourceKey.length).toBeGreaterThan(0);
      }
      expect(entry.label.length).toBeGreaterThan(0);
      expect(validLifecycles.has(entry.lifecycle)).toBe(true);
    }
  });

  it("publishes runtime source keys for exact sources instead of synthetic ids", async () => {
    const res = await handleYieldAdapterManifest();
    const body = (await res.json()) as YieldAdapterManifestResponse;

    expect(
      body.entries.find((entry) =>
        entry.stablecoinId === "susde-ethena" &&
        entry.family === "defillama" &&
        entry.sourceKey === YIELD_POOL_MAP["susde-ethena"]
      ),
    ).toBeTruthy();
    expect(
      body.entries.some((entry) => entry.stablecoinId === "susde-ethena" && entry.sourceKey === "defillama:susde-ethena"),
    ).toBe(false);

    for (const stablecoinId of ["cgusd-cygnus-finance", "usdn-noble"]) {
      expect(RATE_DERIVED_CONFIGS.some((config) => config.stablecoinId === stablecoinId)).toBe(true);
      expect(
        body.entries.find((entry) =>
          entry.stablecoinId === stablecoinId &&
          entry.family === "rate-derived" &&
          entry.sourceKey === "rate-derived"
        ),
      ).toBeTruthy();
      expect(
        body.entries.some((entry) => entry.stablecoinId === stablecoinId && entry.sourceKey === `rate-derived:${stablecoinId}`),
      ).toBe(false);
    }

    expect(body.entries.some((entry) => entry.stablecoinId === "cetes-etherfuse")).toBe(false);

    expect(
      body.entries.find((entry) =>
        entry.stablecoinId === "sdusd-dtrinity" &&
        entry.family === "defillama" &&
        entry.sourceKey === YIELD_WEIGHTED_POOL_GROUPS["sdusd-dtrinity"].sourceKey
      ),
    ).toBeTruthy();
  });

  it("keeps disabled and runtime-resolved strategies from pretending to be joinable history keys", async () => {
    const res = await handleYieldAdapterManifest();
    const body = (await res.json()) as YieldAdapterManifestResponse;

    const scrvusdCurrentRate = body.entries.find((entry) =>
      entry.stablecoinId === "scrvusd-curve" &&
      entry.sourceKey === "onchain:scrvusd-curve:scrvusd-current-rate"
    );
    expect(scrvusdCurrentRate).toMatchObject({
      family: "onchain",
      lifecycle: "active",
    });

    const scrvusdQuarantined = body.entries.find((entry) =>
      entry.stablecoinId === "scrvusd-curve" &&
      entry.lifecycle === "quarantined"
    );
    expect(scrvusdQuarantined).toMatchObject({
      family: "onchain",
      sourceKey: null,
      sourceKeyPattern: "onchain:scrvusd-curve",
    });

    const variantRow = body.entries.find((entry) =>
      entry.stablecoinId === "iusd-infinifi" &&
      entry.family === "defillama" &&
      entry.sourceKeyPattern === "defillama:<runtime-pool-uuid>"
    );
    expect(variantRow).toMatchObject({
      sourceKey: null,
      lifecycle: "active",
    });

    for (const baseAssetId of ["dola-inverse-finance", "gho-aave", "reusd-re-protocol"]) {
      expect(
        body.entries.some((entry) =>
          entry.stablecoinId === baseAssetId &&
          entry.family === "defillama" &&
          entry.sourceKeyPattern === "defillama:<runtime-pool-uuid>"
        ),
      ).toBe(false);
    }
  });

  it("registers /api/yield-adapter-manifest as a public GET route", () => {
    const match = getRouteMatch("/api/yield-adapter-manifest");
    expect(match).not.toBeNull();
    expect(match?.methods).toContain("GET");
    expect(match?.endpoint?.adminRequired).toBe(false);
  });
});
