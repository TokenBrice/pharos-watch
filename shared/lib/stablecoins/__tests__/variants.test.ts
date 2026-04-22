import { describe, expect, it } from "vitest";
import {
  deriveVariantAwareDependencies,
  getVariantParent,
  getVariantRelationship,
  getVariants,
  isTrackedVariant,
} from "../index";

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
    expect(isTrackedVariant("usde-ethena")).toBe(false);
    expect(isTrackedVariant("susdai-usd-ai")).toBe(false);
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
