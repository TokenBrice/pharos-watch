import { describe, expect, it } from "vitest";
import {
  deriveVariantAwareDependencies,
  getVariantParent,
  getVariantRelationship,
  getVariants,
  isTrackedVariant,
  TRACKED_STABLECOINS,
} from "../index";
import { getTrackedBlacklistStatus } from "../../tracked-blacklist-status";

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
    expect(isTrackedVariant("busd0-usual")).toBe(true);
    expect(isTrackedVariant("sbold-k3-capital")).toBe(true);
    expect(isTrackedVariant("usde-ethena")).toBe(false);
    expect(isTrackedVariant("syrupusdc-maple")).toBe(false);
  });

  it("never resolves an unauthored tracked variant to a weaker blacklistable status than its parent", () => {
    // Strength: false < possible < inherited < true. A variant without an
    // explicit `canBeBlacklisted` override must never downgrade below the
    // parent's freeze exposure; its own stronger governance (e.g., centralized)
    // may still elevate it further.
    const strength = (status: ReturnType<typeof getTrackedBlacklistStatus>) =>
      status === true ? 3 : status === "inherited" ? 2 : status === "possible" ? 1 : 0;

    for (const variant of TRACKED_STABLECOINS.filter((meta) => meta.variantOf)) {
      if (variant.canBeBlacklisted !== undefined) continue;
      const parentStatus = getTrackedBlacklistStatus(variant.variantOf!);
      const variantStatus = getTrackedBlacklistStatus(variant.id);
      expect(strength(variantStatus)).toBeGreaterThanOrEqual(strength(parentStatus));
    }
  });

  it("resolves stkgho-umbrella-aave to upstream via gho-aave inheritance", () => {
    // Regression: before the variant-aware inheritance rule, this resolved to
    // `false` because gho-aave was not in blacklistableIds and
    // no reserve-text pattern matched "gho".
    expect(getTrackedBlacklistStatus("gho-aave")).toBe("inherited");
    expect(getTrackedBlacklistStatus("stkgho-umbrella-aave")).toBe("inherited");
  });

  it("normalizes variant-aware dependencies to a single synthetic wrapper edge", () => {
    expect(deriveVariantAwareDependencies({
      variantOf: "usds-sky",
      dependencies: [
        { id: "usds-sky", weight: 0.5, type: "collateral" },
        { id: "usdc-circle", weight: 0.2, type: "mechanism" },
      ],
      reserves: undefined,
    })).toEqual([
      { id: "usdc-circle", weight: 0.2, type: "mechanism" },
      { id: "usds-sky", weight: 1, type: "wrapper" },
    ]);
  });
});
