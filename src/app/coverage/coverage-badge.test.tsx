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

  it("uses compact source-count labels on mobile cards", () => {
    const { container } = render(
      <CoverageBadge
        compact
        status={status({
          label: "2 src",
          spokenLabel: "Price covered by two sources",
          sourceCount: 2,
          detail: "Two price sources are available.",
        })}
      />,
    );

    expect(screen.getByLabelText("Price covered by two sources (2). Two price sources are available.")).toBeTruthy();
    expect(container.textContent).toContain("(2)");
    expect(container.textContent).not.toContain("(2 sources)");
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
});
