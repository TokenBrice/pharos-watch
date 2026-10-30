import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleYieldAdapterManifest } from "../yield-adapter-manifest";
import { API_CACHE_PROFILES as CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { YIELD_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/constants";
import { YIELD_METHODOLOGY_CHANGELOG } from "@shared/lib/methodology-versions/registry";
import { YIELD_ADAPTER_MANIFEST } from "../../lib/yield-config/yield-config";
import { RATE_DERIVED_CONFIGS } from "../../lib/yield-config/yield-config-rate-sources";
import { YIELD_POOL_MAP } from "../../lib/yield-config/yield-config-pools";
import { YIELD_VARIANT_MAP } from "../../lib/yield-config/yield-config-variants";
import {
  YieldAdapterManifestResponseSchema,
  type YieldAdapterManifestResponse,
} from "@shared/types/yield";

describe("handleYieldAdapterManifest", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 200 JSON with the typed manifest payload", async () => {
    const res = await handleYieldAdapterManifest();
    expect(res.headers.get("Content-Type")).toContain("application/json");

    const body = (await readJsonResponse(res, 200)) as YieldAdapterManifestResponse;
    expect(() => YieldAdapterManifestResponseSchema.parse(body)).not.toThrow();
    // Plain `8.43`, the same format `/api/yield-rankings` publishes; the previous
    // `v8.43` label made two endpoints describe one methodology differently.
    expect(body.methodologyVersion).toBe(YIELD_METHODOLOGY_VERSION);
    expect(body.methodologyVersion).not.toContain("v");
    expect(typeof body.updatedAt).toBe("number");
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.length).toBeGreaterThan(0);

    // C18: the stamp is registry evidence, never the epoch, and it is at least the
    // newest adapter lifecycle review the registry carries.
    const newestReviewSec = Math.max(
      ...YIELD_ADAPTER_MANIFEST.flatMap((entry) => entry.strategies
        .map((strategy) => strategy.lifecycleReason?.since)
        .filter((since): since is string => typeof since === "string")
        .map((since) => Math.floor(Date.parse(`${since}T00:00:00Z`) / 1000))),
    );
    expect(body.updatedAt).toBeGreaterThanOrEqual(newestReviewSec);
    expect(body.updatedAt).toBeGreaterThan(1_700_000_000);
    const nowSec = Math.floor(Date.now() / 1000);
    const newestMethodologySec = Math.max(
      ...YIELD_METHODOLOGY_CHANGELOG
        .filter((entry) => entry.effectiveAt <= nowSec)
        .map((entry) => entry.effectiveAt),
    );
    expect(body.updatedAt).toBe(Math.max(newestReviewSec, newestMethodologySec));
  });

  it("serves freshness headers derived from the registry revision", async () => {
    const res = await handleYieldAdapterManifest();
    expect(Number(res.headers.get("X-Data-Age"))).toBeGreaterThan(0);
    expect(res.headers.get("Warning")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe(CACHE_PROFILES.standard);
  });

  it("ignores a future methodology revision until its serve-clock activation boundary", async () => {
    const latestEntry = YIELD_METHODOLOGY_CHANGELOG.reduce(
      (latest, entry) => entry.effectiveAt > latest.effectiveAt ? entry : latest,
    );
    const priorRevisionSec = Math.max(
      ...YIELD_METHODOLOGY_CHANGELOG
        .filter((entry) => entry.effectiveAt < latestEntry.effectiveAt)
        .map((entry) => entry.effectiveAt),
    );
    const newestReviewSec = Math.max(
      ...YIELD_ADAPTER_MANIFEST.flatMap((entry) => entry.strategies
        .map((strategy) => strategy.lifecycleReason?.since)
        .filter((since): since is string => typeof since === "string")
        .map((since) => Math.floor(Date.parse(`${since}T00:00:00Z`) / 1000))),
    );
    vi.useFakeTimers();
    vi.setSystemTime((latestEntry.effectiveAt - 1) * 1000);

    const before = await handleYieldAdapterManifest();
    const beforeBody = (await before.json()) as YieldAdapterManifestResponse;
    expect(beforeBody.updatedAt).toBe(Math.max(newestReviewSec, priorRevisionSec));
    expect(beforeBody.updatedAt).toBeLessThan(latestEntry.effectiveAt);
    expect(Number(before.headers.get("X-Data-Age"))).toBe(latestEntry.effectiveAt - 1 - beforeBody.updatedAt);
    expect(before.headers.get("Warning")).toBeNull();
    expect(before.headers.get("Cache-Control")).toBe(CACHE_PROFILES.standard);

    vi.setSystemTime(latestEntry.effectiveAt * 1000);
    const activated = await handleYieldAdapterManifest();
    const activatedBody = (await activated.json()) as YieldAdapterManifestResponse;
    expect(activatedBody.updatedAt).toBe(Math.max(newestReviewSec, latestEntry.effectiveAt));
    expect(activated.headers.get("X-Data-Age")).toBe("0");
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

    for (const stablecoinId of ["cgusd-cygnus-finance"]) {
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

    expect(body.entries.some((entry) => entry.stablecoinId === "sdusd-dtrinity")).toBe(false);
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
    expect(scrvusdQuarantined).toBeUndefined();

    expect(YIELD_VARIANT_MAP["iusd-infinifi"]).toMatchObject({
      variantSymbol: "siUSD",
    });
    expect(body.entries.some((entry) => entry.stablecoinId === "iusd-infinifi")).toBe(false);

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
});
