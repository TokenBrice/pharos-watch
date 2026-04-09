import { describe, expect, it } from "vitest";
import { buildVisiblePsiChartEvents } from "@/lib/psi-history-events";

describe("buildVisiblePsiChartEvents", () => {
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
