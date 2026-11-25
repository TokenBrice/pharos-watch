// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CoverageBadge } from "@/components/coverage/coverage-badge";
import type { CoverageStatus } from "@/lib/coverage";

function status(overrides: Partial<CoverageStatus> = {}): CoverageStatus {
  return {
    kind: "tracked",
    label: "Tracked",
    spokenLabel: "Tracked coverage",
    tone: "emerald",
    available: true,
    sortRank: 2,
    detail: "Coverage is available.",
    ...overrides,
  };
}

describe("CoverageBadge", () => {
  it("uses source count and pricing source names in content and accessible labels", () => {
    const { container } = render(
      <CoverageBadge
        status={status({
          label: "3+ src",
          spokenLabel: "Price covered by at least three sources",
          detail: "Three independent price sources are available.",
          sourceCount: 3,
          sourceNames: ["coingecko"],
          priceConfidence: "high",
        })}
      />,
    );

    const badge = screen.getByLabelText(
      "Price covered by at least three sources (3 sources). High confidence — CoinGecko",
    );
    expect(badge.getAttribute("title")).toBe("High confidence — CoinGecko");
    expect(container.textContent).toContain("3+ src");
    expect(container.textContent).toContain("(3 sources)");
  });

  it("preserves state-specific labels for unavailable redemption states", () => {
    const { rerender } = render(
      <CoverageBadge
        status={status({
          kind: "data-unavailable",
          label: "Data n/a",
          spokenLabel: "Data unavailable",
          tone: "slate",
          available: false,
          detail: "Redemption backstop data is unavailable.",
        })}
      />,
    );

    expect(screen.getByLabelText("Data unavailable. Redemption backstop data is unavailable.")).toBeTruthy();

    rerender(
      <CoverageBadge
        status={status({
          kind: "impaired",
          label: "Impaired",
          spokenLabel: "Impaired route",
          tone: "amber",
          available: false,
          detail: "Current market evidence contradicts strong redemption coverage.",
        })}
      />,
    );

    expect(
      screen.getByLabelText("Impaired route. Current market evidence contradicts strong redemption coverage."),
    ).toBeTruthy();
  });

  it("renders routine absent slate cells quietly in compact mode while keeping hatched dashed pills for unavailable/checking", () => {
    const { rerender } = render(
      <CoverageBadge
        compact
        status={status({
          kind: "none",
          label: "Not Covered",
          spokenLabel: "Not covered",
          tone: "slate",
          available: false,
          detail: "No route configured.",
        })}
      />,
    );

    const quiet = screen.getByLabelText("Not covered. No route configured.");
    expect(quiet.getAttribute("title")).toBe("No route configured.");
    expect(quiet.className).toContain("text-muted-foreground");
    expect(quiet.className).not.toContain("text-muted-foreground/75");
    expect(quiet.className).not.toContain("border-dashed");
    expect(quiet.className).not.toContain("rounded-sm");

    rerender(
      <CoverageBadge
        compact
        status={status({
          kind: "data-unavailable",
          label: "Data n/a",
          spokenLabel: "Data unavailable",
          tone: "amber",
          available: false,
          detail: "Feed offline.",
        })}
      />,
    );

    const unavailable = screen.getByLabelText("Data unavailable. Feed offline.");
    expect(unavailable.className).toContain("border-dashed");
    expect(unavailable.className).toContain("rounded-sm");

    rerender(
      <CoverageBadge
        compact
        status={status({
          kind: "checking",
          label: "Checking",
          spokenLabel: "Checking live reserve sync",
          tone: "amber",
          available: false,
          detail: "Live reserve sync is checking.",
        })}
      />,
    );

    const checking = screen.getByLabelText("Checking live reserve sync. Live reserve sync is checking.");
    expect(checking.className).toContain("border-dashed");
    expect(checking.className).toContain("rounded-sm");
  });

  it("uses a distinct diamond glyph for rose badges so rose and slate differ without color", () => {
    const { container } = render(
      <CoverageBadge
        compact
        status={status({
          kind: "missing",
          label: "Missing",
          spokenLabel: "Missing",
          tone: "rose",
          available: false,
          detail: "No observed price.",
        })}
      />,
    );

    const badge = screen.getByLabelText("Missing. No observed price.");
    expect(badge.className).toContain("rounded-sm");
    expect(badge.className).toContain("min-w-[3.75rem]");
    expect(container.textContent).toContain("\u25C6");
    expect(container.textContent).not.toContain("\u2212");
  });
});
