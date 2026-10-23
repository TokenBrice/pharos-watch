// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PUBLIC_COMPONENT_STATE_TONE } from "@shared/lib/classification";
import { UptimeBar, summarizeDayCells } from "../uptime-bar";

describe("UptimeBar", () => {
  it("colours observed days by component state and keeps no-data days apart", () => {
    const cells = [
      { date: "2026-10-11", state: "no-data" as const },
      { date: "2026-10-12", state: "degraded" as const },
      { date: "2026-10-13", state: "operational" as const },
    ];
    const { container } = render(<UptimeBar cells={cells} label="Yield" />);

    expect(container.querySelector('[title="2026-10-11: No data"]')?.className).toContain("bg-muted");
    expect(container.querySelector('[title="2026-10-12: Degraded"]')?.className).toContain(PUBLIC_COMPONENT_STATE_TONE.degraded.bar);
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe(
      "Yield, last 3 days: 1d operational · 1d degraded · 1d no data",
    );
  });

  it("keeps a sub-hour blip in the tooltip without colouring the day", () => {
    const { container } = render(
      <UptimeBar cells={[{ date: "2026-10-22", state: "operational", brief: "degraded" }]} label="Stablecoin data" />,
    );
    expect(container.querySelector('[title="2026-10-22: Operational (briefly degraded, under 1 h)"]')?.className)
      .toContain(PUBLIC_COMPONENT_STATE_TONE.operational.bar);
  });

  it("never counts no-data days as operational", () => {
    expect(summarizeDayCells([{ date: "a", state: "no-data" }, { date: "b", state: "no-data" }])).toBe("2d no data");
  });
});
