import { describe, expect, it } from "vitest";
import initiaIusdAsset from "../../../data/stablecoins/coins/iusd-initia.json";
import initiaIusdReserves from "../../../data/stablecoins/domains/reserves/iusd-initia.json";
import { StablecoinMetaSourceAssetSchema } from "../schema";
import { deriveEffectiveDependencies } from "../../dependency-derivation";
import { resolveBlacklistStatuses } from "../../report-card-blacklist-matchers";
import type { StablecoinMeta, VariantKind } from "../../../types";
import { ACTIVE_META_BY_ID, ACTIVE_STABLECOINS, TRACKED_STABLECOINS } from "../registry";
import { isActiveStablecoinMeta } from "../status";
import { createVariantRelationshipHelpers } from "../variant-relationships";

function hasTrackedVariantMeta(
  meta: StablecoinMeta | undefined,
): meta is StablecoinMeta & { variantOf: string; variantKind: VariantKind } {
  return meta?.variantOf != null && meta.variantKind != null && isActiveStablecoinMeta(meta);
}

const { getVariantParent, getVariantRelationship, getVariants, isTrackedVariant } = createVariantRelationshipHelpers({
  activeMetaById: ACTIVE_META_BY_ID,
  activeStablecoins: ACTIVE_STABLECOINS,
  hasTrackedVariantMeta,
});

const trackedBlacklistStatuses = resolveBlacklistStatuses(TRACKED_STABLECOINS);

describe("stablecoin variants", () => {
  it("resolves a tracked variant parent", () => {
    expect(getVariantParent("susds-sky")?.id).toBe("usds-sky");
    expect(getVariantParent("usds-sky")).toBeNull();
  });

  it("returns parent relationship details and siblings", () => {
    const relationship = getVariantRelationship("stusds-sky");

    expect(relationship?.parent.id).toBe("usds-sky");
    expect(relationship?.kind).toBe("risk-absorption");
    expect(relationship?.siblings.map((coin) => coin.id)).toContain("susds-sky");
  });

  it("returns tracked child variants for a parent", () => {
    expect(getVariants("usds-sky").map((coin) => coin.id)).toEqual(["susds-sky", "stusds-sky"]);
  });

  it("marks only authored tracked variants", () => {
    expect(isTrackedVariant("susde-ethena")).toBe(true);
    expect(isTrackedVariant("susdai-usd-ai")).toBe(true);
    expect(isTrackedVariant("busd0-usual")).toBe(false);
    expect(isTrackedVariant("sbold-k3-capital")).toBe(true);
    expect(isTrackedVariant("syrupusdc-maple")).toBe(true);
    expect(isTrackedVariant("syrupusdt-maple")).toBe(true);
    expect(isTrackedVariant("yusd-yieldfi")).toBe(true);
    expect(isTrackedVariant("usde-ethena")).toBe(false);
  });

  it("keeps stkgho's direct pause authority above gho-aave's upstream status", () => {
    // GHO crosses the strict majority upstream threshold through GSM exposure,
    // while stkGHO keeps its local pause authority.
    expect(trackedBlacklistStatuses.get("gho-aave")).toBe("inherited");
    expect(trackedBlacklistStatuses.get("stkgho-umbrella-aave")).toBe(true);
  });

  it("normalizes variant-aware dependencies to a single synthetic wrapper edge", () => {
    expect(
      deriveEffectiveDependencies({
        variantOf: "usds-sky",
        dependencies: [
          { id: "usds-sky", weight: 0.5, type: "collateral" },
          { id: "usdc-circle", weight: 0.2, type: "mechanism" },
        ],
        reserves: undefined,
      }),
    ).toEqual([{ id: "usds-sky", weight: 1, type: "wrapper" }]);
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
