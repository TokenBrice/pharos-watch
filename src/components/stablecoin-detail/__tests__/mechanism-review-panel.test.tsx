// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { getMechanismExplainerPath } from "@shared/lib/classification";
import { MechanismReviewPanel } from "../mechanism-review-panel";
import type { MechanismReviewView } from "@/lib/mechanism-review";

const review: MechanismReviewView = {
  archetype: "cdp",
  reviewedAt: "2026-07-15",
  notes: "Vaults liquidate below the minimum ratio.\nThe stability pool absorbs bad debt.",
  sources: [
    { label: "Protocol docs", url: "https://example.com/docs" },
    { label: "Audit report", url: "https://example.com/audit" },
  ],
};

describe("MechanismReviewPanel", () => {
  it("renders nothing without a review", () => {
    const { container } = render(<MechanismReviewPanel review={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the full notes and every cited source as an external link", () => {
    render(<MechanismReviewPanel review={review} />);
    expect(screen.getByText(/stability pool absorbs bad debt/).textContent).toBe(review.notes);
    for (const source of review.sources) {
      const link = screen.getByRole("link", { name: source.label });
      expect(link.getAttribute("href")).toBe(source.url);
      expect(link.getAttribute("target")).toBe("_blank");
    }
  });

  it("links the archetype explainer without lower-casing its acronym", () => {
    render(<MechanismReviewPanel review={review} />);
    const explainerPath = getMechanismExplainerPath("cdp").replace(/\/$/, "");
    const explainer = screen.getAllByRole("link").find((link) => link.getAttribute("href")?.replace(/\/$/, "") === explainerPath);
    expect(explainer).toBeTruthy();
    expect(explainer!.textContent).not.toMatch(/\bcdp\b/);
  });

  it("leaves the anchor and the date to the strip that hosts it", () => {
    const { container } = render(<MechanismReviewPanel review={review} />);
    expect(container.querySelector("#mechanism-review")).toBeNull();
    expect(container.textContent).not.toContain(review.reviewedAt);
  });
});
