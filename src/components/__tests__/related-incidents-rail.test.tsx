// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { RelatedIncidentsRail } from "@/components/related-incidents-rail";

describe("RelatedIncidentsRail", () => {
  it("labels the same-peg group from the peg vocabulary, never the wire enum", () => {
    render(<RelatedIncidentsRail excludeEventId="lusd-2026-10-29" pegCurrency="USD" />);

    expect(screen.getByText("Other recent US Dollar depegs")).toBeTruthy();
    expect(screen.getAllByRole("link")).toHaveLength(3);
    expect(screen.queryByText(/peggedUSD/)).toBeNull();
  });

  it("uses the shared mechanism-archetype label in the heading", () => {
    const view = render(<RelatedIncidentsRail riskArchetype="cdp" />);

    expect(screen.getByText("Other Crypto CDP incidents")).toBeTruthy();
    expect(view.container.textContent).not.toMatch(/cdp incidents|fiat-cash/);
  });
});
