// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { countSummaryWords } from "@shared/lib/summary-budget";
import { MechanismReviewPanel } from "../mechanism-review-panel";
import type { MechanismReviewView } from "@/lib/mechanism-review";

const review: MechanismReviewView = {
  archetype: "fiat-cash",
  reviewedAt: "2026-07-15",
  notes: "Reserves are held in Segregated Accounts apart from corporate funds.",
  sources: [
    { label: "Circle USDC Terms", url: "https://example.com/terms" },
    { label: "Deloitte examination report", url: "https://example.com/deloitte" },
  ],
};

function getSourcesToggle() {
  return screen.getByRole("button", { name: /Sources/ });
}

function getSourcesContainer(container: HTMLElement) {
  const link = container.querySelector('a[href="https://example.com/deloitte"]');
  return link?.closest("div") ?? null;
}

describe("MechanismReviewPanel", () => {

  it("states one bounded verdict and keeps the notes behind Review notes", () => {
    render(<MechanismReviewPanel review={review} />);
    const verdict = screen.getByText(/^Reviewed against \d+ cited sources? as a /);
    expect(countSummaryWords(verdict.textContent ?? "")).toBeLessThanOrEqual(25);
    expect(screen.getByText("Review notes")).toBeTruthy();
    expect(screen.getByText(/Segregated Accounts/).closest("details")?.hasAttribute("open")).toBe(false);
    expect(screen.queryByRole("button", { name: /Read more/ })).toBeNull();
  });

  it("renders nothing without a review", () => {
    const { container } = render(<MechanismReviewPanel review={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders archetype, review date and notes, sources folded but in the DOM", () => {
    const { container } = render(<MechanismReviewPanel review={review} />);
    expect(screen.getByText("Custodial Cash and Cash-Equivalents")).toBeTruthy();
    expect(screen.getByText(/Reviewed 2026-07-15/)).toBeTruthy();
    expect(screen.getByText(/Segregated Accounts/)).toBeTruthy();

    // Folded by default at every breakpoint, but citations stay crawlable.
    const toggle = getSourcesToggle();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const sourcesContainer = getSourcesContainer(container);
    expect(sourcesContainer?.hasAttribute("hidden")).toBe(true);

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(getSourcesContainer(container)?.hasAttribute("hidden")).toBe(false);
    expect(screen.getByRole("link", { name: /Deloitte examination report/ }).getAttribute("href"))
      .toBe("https://example.com/deloitte");
  });

  it("leaves the anchor to the fold band wrapping it", () => {
    // `#mechanism-review` lives on the `RailCopyFold` band in the Backing
    // evidence group, so the anchor lands on the band, not on the body.
    const { container } = render(<MechanismReviewPanel review={review} />);
    expect(container.querySelector("#mechanism-review")).toBeNull();
  });

  it("folds long in-flow notes whole behind Review notes", () => {
    const longNotes = `${review.notes} `.repeat(20).trim();
    render(<MechanismReviewPanel review={{ ...review, notes: longNotes }} />);

    expect(screen.getByText("Review notes")).toBeTruthy();
    expect(screen.getByText(/Segregated Accounts/).textContent).toBe(longNotes);
    // The prose fold and the sources fold are independent controls.
    expect(getSourcesToggle().getAttribute("aria-expanded")).toBe("false");
  });

});
