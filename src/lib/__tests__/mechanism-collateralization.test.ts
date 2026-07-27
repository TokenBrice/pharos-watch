import { describe, expect, it } from "vitest";
import { buildMechanismCollateralizationView } from "../mechanism-collateralization";

describe("buildMechanismCollateralizationView", () => {
  it("extracts the measured CDP ratio, backstop, and provenance", () => {
    const view = buildMechanismCollateralizationView("bold-liquity");
    expect(view).not.toBeNull();
    expect(view?.ratio).toBeGreaterThan(1);
    expect(view?.liquidationCapacityRatio).toBeGreaterThan(0);
    expect(view?.notApplicableRationale).toBeNull();
    expect(view?.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(view?.sourceUrl).toMatch(/^https:\/\//);
    expect(view?.sourceLabel.length).toBeGreaterThan(0);
  });

  it("carries the reviewed not-applicable ruling instead of a number", () => {
    // jpym-mento: CR ruled structurally not applicable (Mento conversion token).
    const view = buildMechanismCollateralizationView("jpym-mento");
    expect(view).not.toBeNull();
    expect(view?.ratio).toBeNull();
    expect(view?.notApplicableRationale).toMatch(/vault|conversion/i);
  });

  it("returns null for non-CDP archetypes and unknown assets", () => {
    // ceur-celo carries a fiat-cash overlay: no comparable reviewed ratio.
    expect(buildMechanismCollateralizationView("ceur-celo")).toBeNull();
    expect(buildMechanismCollateralizationView("not-a-real-coin")).toBeNull();
  });
});
