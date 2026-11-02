// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { YieldChangeAttributionCard } from "@/components/yield-change-attribution-card";

describe("YieldChangeAttributionCard", () => {
  it("does not label a source-switch delta as a 30d APY impact", () => {
    const { container } = render(
      <YieldChangeAttributionCard
        attribution={{
          attribution: "source-switch",
          confidence: "medium",
          headline: "Source switched from Aave (+1.2pp impact).",
          largestDelta: { value: 1.2, ts: Date.UTC(2026, 9, 1) },
          sourceSwitchDetail: { previousSourceKey: "aave", previousSourceLabel: "Aave", apy30dDelta: 1.2 },
        }}
      />,
    );

    expect(container.textContent).toContain("impact on APY.");
    expect(container.textContent).not.toContain("impact on 30d APY");
  });
});
