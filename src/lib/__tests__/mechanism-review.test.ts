import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMechanismReviewOverlay, type MechanismOverlayEntry } from "../mechanism-overlay.server";
import { buildMechanismReviewView } from "../mechanism-review";

vi.mock("../mechanism-overlay.server", () => ({ getMechanismReviewOverlay: vi.fn() }));

let overlay: MechanismOverlayEntry;
beforeEach(() => {
  overlay = {
    assetId: "test", archetype: "fiat-cash", reviewedAt: "2026-07-28",
    notes: "  Reviewed evidence.  ", sources: [{ label: "Issuer", url: "https://example.com/reserves" }],
    metrics: {}, components: {},
  };
  vi.mocked(getMechanismReviewOverlay).mockReturnValue(overlay);
});

describe("buildMechanismReviewView", () => {
  it("trims narrative and exposes only public evidence fields", () => {
    expect(buildMechanismReviewView("test")).toEqual({
      archetype: "fiat-cash", reviewedAt: "2026-07-28", notes: "Reviewed evidence.",
      sources: [{ label: "Issuer", url: "https://example.com/reserves" }],
    });
  });

  it("returns null for unknown assets", () => {
    vi.mocked(getMechanismReviewOverlay).mockReturnValue(null);
    expect(buildMechanismReviewView("unknown")).toBeNull();
  });

  it("rejects absent or unusable citations despite valid narrative", () => {
    for (const sources of [[], [{ label: " ", url: "https://example.com" }], [{ label: "Issuer", url: "\t" }]]) {
      overlay.sources = sources;
      expect(buildMechanismReviewView("test")).toBeNull();
    }
  });

  it("filters invalid citations without dropping the valid evidence", () => {
    overlay.sources.push({ label: " ", url: "https://invalid.example" }, { label: "Invalid", url: " " });
    expect(buildMechanismReviewView("test")).toEqual({
      archetype: "fiat-cash", reviewedAt: "2026-07-28", notes: "Reviewed evidence.",
      sources: [{ label: "Issuer", url: "https://example.com/reserves" }],
    });
  });

});
