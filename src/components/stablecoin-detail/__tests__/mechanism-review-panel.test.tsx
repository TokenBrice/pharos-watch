// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RAIL_PROSE_LEAD_CHARS } from "@/components/stablecoin-detail/prose-lead";
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

/** Long enough to exceed the rail fold threshold, as production notes are. */
const longReview: MechanismReviewView = {
  ...review,
  notes: `Reserves are held in Segregated Accounts apart from corporate funds. ${"Reviewed evidence continues at length. ".repeat(12)}`,
};

function getSourcesToggle() {
  return screen.getByRole("button", { name: /Sources/ });
}

function getSourcesContainer(container: HTMLElement) {
  const link = container.querySelector('a[href="https://example.com/deloitte"]');
  return link?.closest("div") ?? null;
}

describe("MechanismReviewPanel", () => {

  it("shows no fold affordance when the rail copy is short enough to render whole", () => {
    render(<MechanismReviewPanel review={review} compact />);
    expect(screen.getByText(/Segregated Accounts/).textContent).toBe(review.notes);
    expect(screen.queryByRole("button", { name: /Read more/ })).toBeNull();
  });

  it("renders nothing without a review", () => {
    const { container } = render(<MechanismReviewPanel review={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the full section with archetype and notes, sources folded but in the DOM", () => {
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

  it("leaves the anchor and the xl gate to the fold band wrapping the in-flow copy", () => {
    // `#mechanism-review` and `xl:hidden` moved onto the `RailCopyFold` band in
    // the Context zone: the anchor must land on the collapsed header, not on a
    // card body inside it.
    const { container } = render(<MechanismReviewPanel review={review} />);
    expect(container.querySelector("#mechanism-review")).toBeNull();
    expect(container.querySelector('[class*="xl:hidden"]')).toBeNull();
  });

  it("cuts long in-flow notes to a lead behind one control", () => {
    const longNotes = `${review.notes} `.repeat(20).trim();
    render(<MechanismReviewPanel review={{ ...review, notes: longNotes }} />);

    // The cut happens in the string, not with line-clamp: one full-width line
    // carries ~150 characters, so a line-based fold would hide almost nothing.
    const lead = screen.getByText(/Segregated Accounts/).textContent ?? "";
    expect(lead.length).toBeLessThan(400);
    expect(lead.endsWith("…")).toBe(true);
    // The prose fold and the sources fold are independent controls.
    expect(getSourcesToggle().getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: /Read the full review/ }));

    expect(screen.getByText(/Segregated Accounts/).textContent).toBe(longNotes);
    expect(screen.getByRole("button", { name: /Show less/ })).toBeTruthy();
  });

  it("omits the in-flow toggle for notes short enough to lose nothing to the fold", () => {
    render(<MechanismReviewPanel review={review} />);
    expect(screen.queryByRole("button", { name: /Read the full review/ })).toBeNull();
    expect(screen.getByText(/Segregated Accounts/).textContent).toBe(review.notes);
  });

  it("folds the compact rail copy to a lead until it is expanded", () => {
    const { container } = render(<MechanismReviewPanel review={longReview} compact />);
    // Reviewed notes run past 6,000 characters on the longest assets, which
    // cannot render whole in a 22rem rail. The fold is a cut in the string
    // (`prose-lead`), not `line-clamp`, so it does not move with the viewport.
    const collapsed = screen.getByText(/Segregated Accounts/).textContent ?? "";
    expect(collapsed.length).toBeLessThanOrEqual(RAIL_PROSE_LEAD_CHARS + 1);
    expect(collapsed.endsWith("\u2026")).toBe(true);
    expect(getSourcesContainer(container)?.hasAttribute("hidden")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /Read more/ }));

    const expanded = screen.getByText(/Segregated Accounts/).textContent ?? "";
    expect(expanded.length).toBeGreaterThan(collapsed.length);
    expect(screen.getByRole("button", { name: /Show less/ })).toBeTruthy();

    // Sources open independently through the evidence footer.
    fireEvent.click(getSourcesToggle());
    expect(getSourcesContainer(container)?.hasAttribute("hidden")).toBe(false);
  });

  it("keeps the rail copy free of the anchor id", () => {
    const { container } = render(<MechanismReviewPanel review={review} compact />);
    expect(container.querySelector("#mechanism-review")).toBeNull();
  });
});
