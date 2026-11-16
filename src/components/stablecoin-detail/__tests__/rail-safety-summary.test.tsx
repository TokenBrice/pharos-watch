// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { RailSafetySummary } from "../rail-safety-summary";
import type { HeroSignalRailItem } from "../hero-card-metrics";
import { makeV9Card } from "@/test/fixtures/safety-score-v9";

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
  it("dates a saved release grade and holds pending rows with a placeholder, not a dash", () => {
    const items = signals({ grade: "A-", dews: "" });
    items[0] = { ...items[0]!, note: "as of 2026-10-22" };
    items[3] = { ...items[3]!, pending: true };
    const { container } = render(<RailSafetySummary items={items} gradeRead="pending" />);

    expect(screen.getByText("A-")).toBeTruthy();
    expect(container.querySelector('[data-safety-state="saved"]')?.textContent).toBe("as of 2026-10-22");
    expect(dewsRow().textContent).not.toContain("—");
    expect(dewsRow().querySelector(".animate-pulse")).not.toBeNull();
  });

  it("leaves out a NAV token's peg and DEWS rows, which carry no reading", () => {
    const { container } = render(<RailSafetySummary items={signals({ grade: "B+", dews: "—" })} navToken />);

    expect(screen.queryByText("DEWS")).toBeNull();
    expect(screen.queryByText("Peg")).toBeNull();
    expect(screen.getByText("Liquidity")).toBeTruthy();
    expect(container.textContent).not.toMatch(/N\/A|—/);
  });

  it("dates a live grade and keeps a real DEWS reading for a NAV token untouched", () => {
    render(<RailSafetySummary items={signals({ grade: "B+", dews: "12" })} navToken liveAsOf="as of 2026-11-14 22:03 UTC" />);

    expect(dewsRow().textContent).toContain("12");
    expect(dewsRow().textContent).not.toContain("N/A");
    expect(screen.getByText("as of 2026-11-14 22:03 UTC")).toBeTruthy();
  });

  it("leaves out an unavailable DEWS reading for an ordinary coin instead of a dash row", () => {
    const { container } = render(<RailSafetySummary items={signals({ grade: "B+", dews: "—" })} />);

    expect(screen.queryByText("DEWS")).toBeNull();
    expect(container.textContent).not.toContain("—");
  });

  it("draws no empty signal block when no row carries a reading", () => {
    const items = signals({ grade: "B+", dews: "—" }).map((row) => (row.key === "safety" ? row : { ...row, primary: "—" }));
    const { container } = render(<RailSafetySummary items={items} />);

    expect(container.querySelector(".divide-y")).toBeNull();
  });

  it("reads a frozen archive as not scored rather than a display-size dash", () => {
    const { container } = render(<RailSafetySummary items={signals({ grade: "—", dews: "—" })} frozen />);

    const headline = container.querySelector("[data-safety-state]");
    expect(headline?.textContent).toContain("Frozen");
    expect(headline?.textContent).toContain("not scored");
    expect(headline?.textContent).not.toContain("—");
    expect(screen.queryByText("DEWS")).toBeNull();
  });

  it("shows a loading placeholder, not 'Not scored', while the report-card read is in flight", () => {
    const { container } = render(<RailSafetySummary items={signals({ grade: "—", dews: "—" })} gradeRead="pending" />);

    expect(container.querySelector('[data-safety-state="loading"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Not scored");
  });

  it("says the grade is unavailable after a failed read, never 'Not scored'", () => {
    const { container } = render(<RailSafetySummary items={signals({ grade: "—", dews: "—" })} gradeRead="failed" />);

    expect(container.querySelector('[data-safety-state="unavailable"]')?.textContent).toBe("Grade unavailable");
    expect(container.textContent).not.toContain("Not scored");
  });

  it("keeps a frozen archive's not-scored finding even when the read failed", () => {
    const { container } = render(
      <RailSafetySummary items={signals({ grade: "—", dews: "—" })} frozen gradeRead="failed" />,
    );

    expect(container.querySelector('[data-safety-state="frozen"]')).not.toBeNull();
  });

  it("says a live coin without a published grade is not scored", () => {
    const { container } = render(<RailSafetySummary items={signals({ grade: "—", dews: "40" })} />);

    const headline = container.querySelector("[data-safety-state]");
    expect(headline?.textContent).toContain("Not scored");
    expect(headline?.textContent).not.toContain("Frozen");
  });

  it("explains the grade in words and decomposes it into its three pillars", () => {
    const cap = { kind: "track-record:<24m", limit: 84, reason: "Less than two years of known implementation history.", source: "track-record" as const, binding: true };
    const card = makeV9Card({ score: 84, grade: "A", caps: [cap], bindingCap: cap });
    const { container } = render(<RailSafetySummary items={signals({ grade: "A", dews: "Watch" })} card={card} />);

    expect(container.querySelector("[data-safety-verdict-line]")?.textContent).toContain("Capped at 84");
    const pillars = screen.getByRole("list", { name: "Safety Score pillars" });
    expect(pillars.querySelectorAll("li")).toHaveLength(3);
    expect(pillars.textContent).toContain("Economic Control");
  });
});
