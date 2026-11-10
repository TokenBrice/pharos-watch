// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SelectorEmptyState } from "@/components/selector/selector-empty-state";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

describe("SelectorEmptyState", () => {
  it("does not claim the Screener handoff carries every Picker filter", () => {
    render(
      <SelectorEmptyState
        profile="treasury"
        pegCurrency="USD"
        coverageSparse={false}
        closestSurvivors={[]}
        relaxableConstraints={[]}
        onRelax={() => {}}
        screenerHandoffHref="/screener/?peg=USD"
      />,
    );

    const link = screen.getByRole("link", { name: /Screener/u });
    expect(link.textContent).toBe("Open the Screener with the filters it can carry");
    expect(link.textContent).not.toContain("these filters");
    expect(link.getAttribute("href")).toBe("/screener/?peg=USD");
  });
});
