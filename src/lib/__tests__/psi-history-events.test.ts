import { describe, expect, it } from "vitest";
import { BAND_ZONES, buildVisiblePsiChartEvents } from "@/lib/psi-history-events";
import { PSI_CONDITION_BANDS } from "@shared/lib/psi-policy";
import { PSI_HEX_COLORS } from "@shared/lib/classification";

describe("buildVisiblePsiChartEvents", () => {
  it("derives contiguous chart intervals and colors from the canonical bands", () => {
    expect(BAND_ZONES).toEqual(PSI_CONDITION_BANDS.map(({ min, band }, index) => ({
      y1: min,
      y2: index === 0 ? 100 : PSI_CONDITION_BANDS[index - 1].min,
      color: PSI_HEX_COLORS[band],
      label: band,
    })));
  });

  it("alternates event labels top and bottom in chronological order", () => {
    const events = [
      { label: "Event C", date: Date.UTC(2022, 0, 3), links: [] },
      { label: "Event A", date: Date.UTC(2022, 0, 1), links: [] },
      { label: "Event D", date: Date.UTC(2022, 0, 4), links: [] },
      { label: "Event B", date: Date.UTC(2022, 0, 2), links: [] },
    ] as const;

    expect(buildVisiblePsiChartEvents(events)).toMatchObject([
      { label: "Event A", position: "top", hideLabel: false },
      { label: "Event B", position: "insideBottom", hideLabel: false },
      { label: "Event C", position: "top", hideLabel: false },
      { label: "Event D", position: "insideBottom", hideLabel: false },
    ]);
  });

  it("restarts the alternation from the first event in the visible range", () => {
    const events = [
      { label: "Event A", date: Date.UTC(2022, 0, 1), links: [] },
      { label: "Event B", date: Date.UTC(2022, 0, 2), links: [] },
      { label: "Event C", date: Date.UTC(2022, 0, 3), links: [] },
      { label: "Event D", date: Date.UTC(2022, 0, 4), links: [] },
    ] as const;

    const visibleEvents = buildVisiblePsiChartEvents(
      events,
      Date.UTC(2022, 0, 2),
      Date.UTC(2022, 0, 4),
    );

    expect(visibleEvents).toMatchObject([
      { label: "Event B", position: "top", hideLabel: false },
      { label: "Event C", position: "insideBottom", hideLabel: false },
      { label: "Event D", position: "top", hideLabel: false },
    ]);
  });
});
