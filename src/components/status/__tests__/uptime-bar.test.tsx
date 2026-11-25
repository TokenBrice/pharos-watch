// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

    const noDataCell = container.querySelector('[title="2026-10-11: No data"]');
    expect(noDataCell?.className).toContain("bg-muted/60");
    expect(noDataCell?.className).toContain("ring-border/60");
    expect(container.querySelector('[title="2026-10-12: Degraded"]')?.className).toContain(PUBLIC_COMPONENT_STATE_TONE.degraded.bar);
    expect(screen.getByRole("group").getAttribute("aria-label")).toBe(
      "Yield, last 3 days: 1d operational · 1d degraded · 1d no data",
    );
  });

  it("surfaces a sub-hour blip via top indicator, summary count, and keyboard/tap inspection", () => {
    const { container } = render(
      <UptimeBar cells={[{ date: "2026-10-22", state: "operational", brief: "degraded" }]} label="Stablecoin data" />,
    );
    const cell = container.querySelector('[title="2026-10-22: Operational (briefly degraded, under 1 h)"]') as HTMLButtonElement | null;
    expect(cell?.className).toContain(PUBLIC_COMPONENT_STATE_TONE.operational.bar);
    expect(cell?.querySelector("span")?.className).toContain(PUBLIC_COMPONENT_STATE_TONE.degraded.bar);
    expect(screen.getByRole("group").getAttribute("aria-label")).toBe(
      "Stablecoin data, last 1 days: 1d operational · 1d with brief blip",
    );

    fireEvent.focus(cell!);
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "2026-10-22: Operational (briefly degraded, under 1 h)",
    );

    fireEvent.click(cell!);
    expect(cell?.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(cell!);
    expect(cell?.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector('[aria-live="polite"]')).toBeNull();
  });

  it("never counts no-data days as operational", () => {
    expect(summarizeDayCells([{ date: "a", state: "no-data" }, { date: "b", state: "no-data" }])).toBe("2d no data");
  });
});
