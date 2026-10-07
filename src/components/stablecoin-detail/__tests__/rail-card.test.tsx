// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RAIL_METRIC_MAX_SUB_METRICS, RailMetricCard } from "../rail-card";

describe("RailMetricCard", () => {
  it("renders the headline, its basis and at most the sub-metric ceiling", () => {
    render(
      <RailMetricCard
        id="collateralization"
        title="Collateralization"
        chip={{ label: "Overcollateralized", toneClass: "text-foreground" }}
        value="279.2%"
        valueCaption="vs supply"
        subMetrics={[
          { label: "Liq. backstop", value: "57.5%", hint: "Stability pool as a share of supply" },
          { label: "Reviewed gaps", value: "2" },
          { label: "Overflow", value: "9" },
        ]}
      />,
    );

    const card = screen.getByRole("region", { name: "Collateralization" });
    expect(card.id).toBe("collateralization");
    expect(card.textContent).toContain("279.2%");
    expect(card.textContent).toContain("vs supply");
    expect(card.textContent).toContain("Overcollateralized");
    expect(card.querySelectorAll("dl > div")).toHaveLength(RAIL_METRIC_MAX_SUB_METRICS);
    expect(card.textContent).not.toContain("Overflow");
  });

  it("folds details in one closed disclosure carrying its count", () => {
    const { container } = render(
      <RailMetricCard
        title="Backing"
        value="100.0%"
        details={<p>Alternate ratio vs VAT debt.</p>}
        detailsCount={4}
        freshness="Live · 3h ago"
      />,
    );

    const folds = container.querySelectorAll("details");
    expect(folds).toHaveLength(1);
    expect(folds[0]?.open).toBe(false);
    expect(folds[0]?.contains(screen.getByText("Alternate ratio vs VAT debt."))).toBe(true);
    expect(folds[0]?.querySelector("summary")?.textContent).toContain("(4)");
    expect(folds[0]?.contains(screen.getByText("Live · 3h ago"))).toBe(false);
  });

  it("omits the fold and sub-metric list when there is nothing to show", () => {
    const { container } = render(<RailMetricCard title="Backing" value="–" />);

    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector("dl")).toBeNull();
  });
});
