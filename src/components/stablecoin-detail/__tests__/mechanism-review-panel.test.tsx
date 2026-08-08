// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  afterEach(() => cleanup());

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

  it("hides the in-flow section at xl so it does not duplicate the rail copy", () => {
    const { container } = render(<MechanismReviewPanel review={review} />);
    const section = container.querySelector("#mechanism-review");
    expect(section?.className).toContain("xl:hidden");
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

  it("clamps the compact rail copy until it is expanded", () => {
    const { container } = render(<MechanismReviewPanel review={review} compact />);
    // Reviewed notes run past 6,000 characters on the longest assets, which
    // cannot render unclamped in a 22rem rail.
    const notes = screen.getByText(/Segregated Accounts/);
    expect(notes.className).toContain("line-clamp-3");
    expect(getSourcesContainer(container)?.hasAttribute("hidden")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /Read more/ }));

    expect(screen.getByText(/Segregated Accounts/).className).not.toContain("line-clamp-3");
    expect(screen.getByRole("button", { name: /Show less/ })).toBeTruthy();

    // Sources open independently through the evidence footer.
    fireEvent.click(getSourcesToggle());
    expect(getSourcesContainer(container)?.hasAttribute("hidden")).toBe(false);
  });

  it("keeps the anchor id on the in-flow copy only", () => {
    const { container } = render(<MechanismReviewPanel review={review} compact />);
    expect(container.querySelector("#mechanism-review")).toBeNull();
  });
});
