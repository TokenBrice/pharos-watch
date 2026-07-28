import { describe, expect, it } from "vitest";
import mechanismReviewOverlays from "@shared/data/safety-score-v9/mechanism-review-overlays-v1.json";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";
import { buildMechanismReviewView } from "../mechanism-review";

describe("buildMechanismReviewView", () => {
  it("extracts the reviewed narrative and its cited sources", () => {
    const view = buildMechanismReviewView("usdc-circle");
    expect(view).not.toBeNull();
    expect(view?.archetype).toBe("fiat-cash");
    expect(view?.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(view?.notes.length).toBeGreaterThan(0);
    expect(view?.sources.length).toBeGreaterThan(0);
    expect(view?.sources.every((source) => source.url.startsWith("https://"))).toBe(true);
  });

  it("covers every archetype, not just the CDP cohort the collateral rail serves", () => {
    // fiat-cash and tbill carry no quantitative metrics at all, so the reviewed
    // prose and sources are the only thing there is to surface for them.
    for (const assetId of ["usdc-circle", "bold-liquity", "usde-ethena"]) {
      expect(buildMechanismReviewView(assetId)).not.toBeNull();
    }
  });

  it("does not expose per-dimension quality ratings", () => {
    // Owner decision 2026-07-28: the 5-level quality scale stays internal, so
    // the public view must not carry it even though the overlay does.
    const view = buildMechanismReviewView("usdc-circle");
    expect(Object.keys(view ?? {}).sort()).toEqual(["archetype", "notes", "reviewedAt", "sources"]);
    expect(JSON.stringify(view)).not.toMatch(/"quality"|"components"/);
  });

  it("returns null for unknown assets", () => {
    expect(buildMechanismReviewView("not-a-real-coin")).toBeNull();
  });

  it("resolves every overlay archetype to a known classification value", () => {
    const overlays = mechanismReviewOverlays.overlays as unknown as Array<{ archetype: string }>;
    const unknown = [...new Set(overlays.map((overlay) => overlay.archetype))]
      .filter((archetype) => !(MECHANISM_ARCHETYPE_VALUES as readonly string[]).includes(archetype));
    expect(unknown).toEqual([]);
  });
});
