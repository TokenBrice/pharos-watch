// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RailSafetySummary } from "../rail-safety-summary";
import type { HeroSignalRailItem } from "../hero-card-metrics";

// Vitest hoists the factory above static imports, so the helper loads dynamically.
vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

function item(key: string, label: string, primary: string, secondary: string | null = null): HeroSignalRailItem {
  return { key, label, primary, secondary, href: "#report-card", colorClass: "text-foreground" };
}

function signals({ grade, dews }: { grade: string; dews: string }): HeroSignalRailItem[] {
  return [
    item("safety", "Safety", grade, grade === "—" ? null : "79/100"),
    item("peg", "Peg", "NAV"),
    item("liquidity", "Liquidity", "62", "12 pools"),
    item("dews", "DEWS", dews),
  ];
}

function dewsRow(): HTMLElement {
  const label = screen.getByText("DEWS");
  return label.closest("a")!;
}

describe("RailSafetySummary", () => {
  afterEach(() => {
    cleanup();
  });

  it("states why a NAV token has no DEWS reading instead of a bare dash", () => {
    render(<RailSafetySummary items={signals({ grade: "B+", dews: "—" })} navToken />);

    expect(dewsRow().textContent).toContain("N/A");
    expect(dewsRow().textContent).toContain("NAV");
    expect(dewsRow().textContent).not.toContain("—");
  });

  it("keeps a real DEWS reading for a NAV token untouched", () => {
    render(<RailSafetySummary items={signals({ grade: "B+", dews: "12" })} navToken />);

    expect(dewsRow().textContent).toContain("12");
    expect(dewsRow().textContent).not.toContain("N/A");
  });

  it("leaves an unavailable DEWS reading as unavailable for an ordinary coin", () => {
    render(<RailSafetySummary items={signals({ grade: "B+", dews: "—" })} />);

    expect(dewsRow().textContent).toContain("—");
    expect(dewsRow().textContent).not.toContain("N/A");
  });

  it("reads a frozen archive as not scored rather than a display-size dash", () => {
    const { container } = render(<RailSafetySummary items={signals({ grade: "—", dews: "—" })} frozen />);

    const headline = container.querySelector("[data-safety-state]");
    expect(headline?.textContent).toContain("Frozen");
    expect(headline?.textContent).toContain("not scored");
    expect(headline?.textContent).not.toContain("—");
    expect(dewsRow().textContent).toContain("N/A");
  });

  it("says a live coin without a published grade is not scored", () => {
    const { container } = render(<RailSafetySummary items={signals({ grade: "—", dews: "40" })} />);

    const headline = container.querySelector("[data-safety-state]");
    expect(headline?.textContent).toContain("Not scored");
    expect(headline?.textContent).not.toContain("Frozen");
  });

  it("links a published grade to the report card", () => {
    render(<RailSafetySummary items={signals({ grade: "B+", dews: "40" })} />);

    expect(screen.getByText("B+").closest("a")?.getAttribute("href")).toBe("#report-card");
  });
});
