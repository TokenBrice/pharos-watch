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

describe("MechanismReviewPanel", () => {
  afterEach(() => cleanup());

  it("renders nothing without a review", () => {
    const { container } = render(<MechanismReviewPanel review={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the full section with archetype, notes, and every source", () => {
    render(<MechanismReviewPanel review={review} />);
    expect(screen.getByText("Custodial Cash and Cash-Equivalents")).toBeTruthy();
    expect(screen.getByText(/Reviewed 2026-07-15/)).toBeTruthy();
    expect(screen.getByText(/Segregated Accounts/)).toBeTruthy();
    expect(screen.getByText("Sources (2)")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Deloitte examination report/ }).getAttribute("href"))
      .toBe("https://example.com/deloitte");
  });

  it("hides the in-flow section at xl so it does not duplicate the rail copy", () => {
    const { container } = render(<MechanismReviewPanel review={review} />);
    const section = container.querySelector("#mechanism-review");
    expect(section?.className).toContain("xl:hidden");
  });

  it("clamps the compact rail copy until it is expanded", () => {
    render(<MechanismReviewPanel review={review} compact />);
    // Reviewed notes run past 6,000 characters on the longest assets, which
    // cannot render unclamped in a 22rem rail.
    const notes = screen.getByText(/Segregated Accounts/);
    expect(notes.className).toContain("line-clamp-6");
    expect(screen.queryByText("Sources (2)")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Show more/ }));

    expect(screen.getByText(/Segregated Accounts/).className).not.toContain("line-clamp-6");
    expect(screen.getByText("Sources (2)")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Show less/ })).toBeTruthy();
  });

  it("keeps the anchor id on the in-flow copy only", () => {
    const { container } = render(<MechanismReviewPanel review={review} compact />);
    expect(container.querySelector("#mechanism-review")).toBeNull();
  });
});
