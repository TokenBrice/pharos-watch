import { describe, expect, it } from "vitest";
import initiaIusdAsset from "../../../data/stablecoins/coins/iusd-initia.json";
import initiaIusdReserves from "../../../data/stablecoins/domains/reserves/iusd-initia.json";
import { StablecoinMetaSourceAssetSchema } from "../schema";
import { deriveEffectiveDependencies } from "../../dependency-derivation";
import { resolveBlacklistStatuses } from "../../report-card-blacklist-matchers";
import type { StablecoinMeta, VariantKind } from "../../../types";
import { ACTIVE_META_BY_ID, ACTIVE_STABLECOINS } from "../registry";
import { isActiveStablecoinMeta } from "../status";
import { createVariantRelationshipHelpers } from "../variant-relationships";
import { makeStablecoinMeta } from "../../../test-utils/stablecoin";

function hasTrackedVariantMeta(
  meta: StablecoinMeta | undefined,
): meta is StablecoinMeta & { variantOf: string; variantKind: VariantKind } {
  return meta?.variantOf != null && meta.variantKind != null && isActiveStablecoinMeta(meta);
}

const graph = [
  makeStablecoinMeta({ id: "parent" }),
  makeStablecoinMeta({ id: "child", variantOf: "parent", variantKind: "risk-absorption" }),
  makeStablecoinMeta({ id: "sibling", variantOf: "parent", variantKind: "pure-wrapper" }),
  makeStablecoinMeta({ id: "unrelated", variantOf: "other", variantKind: "pure-wrapper" }),
  makeStablecoinMeta({ id: "orphan", variantOf: "absent", variantKind: "pure-wrapper" }),
  makeStablecoinMeta({ id: "childless" }),
];
const { getVariantParent, getVariantRelationship, getVariants, isTrackedVariant } = createVariantRelationshipHelpers({
  activeMetaById: new Map(graph.map((coin) => [coin.id, coin])),
  activeStablecoins: graph,
  hasTrackedVariantMeta,
});

describe("stablecoin variants", () => {
  it("resolves a parent and exactly its other children, excluding unrelated variants", () => {
    expect(getVariantParent("child")?.id).toBe("parent");
    expect(getVariantParent("parent")).toBeNull();
    const relationship = getVariantRelationship("child");
    expect(relationship?.parent.id).toBe("parent");
    expect(relationship?.kind).toBe("risk-absorption");
    expect(relationship?.siblings.map((coin) => coin.id)).toEqual(["sibling"]);
    expect(getVariants("parent").map((coin) => coin.id)).toEqual(["child", "sibling"]);
  });

  it("returns no relationships or tracked status for an unknown id", () => {
    expect(getVariantParent("unknown")).toBeNull();
    expect(getVariantRelationship("unknown")).toBeNull();
    expect(isTrackedVariant("unknown")).toBe(false);
  });

  it("does not invent a parent relationship for an authored orphan", () => {
    expect(isTrackedVariant("orphan")).toBe(true);
    expect(getVariantParent("orphan")).toBeNull();
    expect(getVariantRelationship("orphan")).toBeNull();
  });

  it("returns an empty variant list for a childless parent", () => {
    expect(getVariants("childless")).toEqual([]);
  });

  it("marks only authored tracked variants", () => {
    const { isTrackedVariant } = createVariantRelationshipHelpers({
      activeMetaById: ACTIVE_META_BY_ID, activeStablecoins: ACTIVE_STABLECOINS, hasTrackedVariantMeta,
    });
    expect(isTrackedVariant("susde-ethena")).toBe(true);
    expect(isTrackedVariant("susdai-usd-ai")).toBe(true);
    expect(isTrackedVariant("busd0-usual")).toBe(false);
    expect(isTrackedVariant("sbold-k3-capital")).toBe(true);
    expect(isTrackedVariant("syrupusdc-maple")).toBe(true);
    expect(isTrackedVariant("syrupusdt-maple")).toBe(true);
    expect(isTrackedVariant("yusd-yieldfi")).toBe(true);
    expect(isTrackedVariant("usde-ethena")).toBe(false);
  });

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
    expect(iusd.reserves).toContainEqual(
      expect.objectContaining({
        pct: 100,
        coinId: "ausd-agora",
        depType: "wrapper",
      }),
    );
    expect(deriveEffectiveDependencies(iusd)).toEqual([
      { id: "ausd-agora", weight: 1, type: "wrapper" },
    ]);
  });
});
