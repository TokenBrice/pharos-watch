import { describe, expect, it } from "vitest";
import initiaIusdAsset from "../../../data/stablecoins/coins/iusd-initia.json";
import initiaIusdReserves from "../../../data/stablecoins/domains/reserves/iusd-initia.json";
import { StablecoinMetaSourceAssetSchema } from "../schema";
import { deriveEffectiveDependencies } from "../../dependency-derivation";
import { resolveBlacklistStatuses } from "../../report-card-blacklist-matchers";
import { makeStablecoinMeta } from "../../../test-utils/stablecoin";

describe("stablecoin variants", () => {
  it("preserves a direct reviewed blacklist status independently of upstream status", () => {
    const review = {
      sourceFreeRationale: "Synthetic reviewed fixture", evidence: "Explicit local authority review",
      reviewer: "test", reviewedAt: "2026-01-01",
    };
    const statuses = resolveBlacklistStatuses([
      makeStablecoinMeta({ id: "upstream", blacklistabilityReview: { ...review, reviewedStatus: "inherited" } }),
      makeStablecoinMeta({ id: "wrapper", variantOf: "upstream", blacklistabilityReview: { ...review, reviewedStatus: true } }),
    ]);
    expect(statuses.get("upstream")).toBe("inherited");
    expect(statuses.get("wrapper")).toBe(true);
  });

  it("normalizes the variant parent claim without discarding an independent manual mechanism", () => {
    expect(
      deriveEffectiveDependencies({
        variantOf: "usds-sky",
        dependencies: [
          { id: "usds-sky", weight: 0.5, type: "collateral" },
          { id: "usdc-circle", weight: 0.2, type: "mechanism" },
        ],
        reserves: undefined,
      }),
    ).toEqual([
      { id: "usds-sky", weight: 1, type: "wrapper" },
      { id: "usdc-circle", weight: 0.2, type: "mechanism" },
    ]);
  });

  it("models Initia iUSD as a pure serial wrapper of AUSD", () => {
    // Parse the source file so schema-defaulted flags (navToken) are present.
    // `reserves` is owned by the reserves sidecar since the D8 migration, so the
    // composed asset is base + sidecar, the same shape the catalog generator builds.
    const iusd = StablecoinMetaSourceAssetSchema.parse({
      ...initiaIusdAsset,
      reserves: initiaIusdReserves.reserves,
    });

    expect(iusd).toMatchObject({
      variantOf: "ausd-agora",
      variantKind: "pure-wrapper",
      pegReferenceId: "ausd-agora",
      flags: { navToken: false },
      dependencyReview: {
        relationships: [
          {
            id: "ausd-agora",
            weight: 1,
            type: "wrapper",
            economicRole: "serial-claim",
          },
        ],
      },
    });
    // The 2026-10-23 Initia halt left the AUSD0/Noble USDC/WETH collateral
    // unmeasured, so the sidecar withholds the wrapper link while the serial
    // variant claim and dependency derivation stand.
    expect(iusd.reserves).toContainEqual(
      expect.objectContaining({
        pct: 100,
        name: "iUSD collateral (unmeasured)",
        risk: "high",
        assetClass: "other",
      }),
    );
    expect(deriveEffectiveDependencies(iusd)).toEqual([
      { id: "ausd-agora", weight: 1, type: "wrapper" },
    ]);
  });
});
