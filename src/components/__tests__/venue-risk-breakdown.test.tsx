// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VenueRiskBreakdown } from "@/components/venue-risk-breakdown";


describe("VenueRiskBreakdown", () => {
  it("renders the five category scores, tier, and weighted score", () => {
    render(
      <VenueRiskBreakdown
        scores={{ audits: 1, centralization: 4, fundsManagement: 3, liquidity: 2, operational: 2 }}
        tier="medium"
        weighted={2.9}
        confidence="verified"
      />,
    );
    expect(screen.getByLabelText("Venue risk breakdown")).toBeTruthy();
    expect(screen.getByText("medium")).toBeTruthy();
    expect(screen.getByText("2.9/5")).toBeTruthy();
    expect(screen.getByLabelText("Audits & track record: 1 out of 5")).toBeTruthy();
    expect(screen.getByLabelText("Centralization & control: 4 out of 5")).toBeTruthy();
    expect(screen.getByLabelText("Operational: 2 out of 5")).toBeTruthy();
    // verified confidence is not badged
    expect(screen.queryByText(/confidence/)).toBeNull();
  });

  it("flags low/partial confidence", () => {
    render(
      <VenueRiskBreakdown
        scores={{ audits: 4, centralization: 4, fundsManagement: 3, liquidity: 4, operational: 4 }}
        tier="high"
        weighted={3.7}
        confidence="low"
      />,
    );
    expect(screen.getByText("high")).toBeTruthy();
    expect(screen.getByText("low confidence")).toBeTruthy();
  });
});
