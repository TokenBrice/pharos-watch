// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { UptimeBar } from "../uptime-bar";

function runwayDates(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[title]"), (node) => node.getAttribute("title")!.slice(0, 10));
}

describe("UptimeBar", () => {
  const ORIGINAL_TZ = process.env.TZ;

  afterEach(() => {
    vi.useRealTimers();
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  });

  it("leaves prior days unknown when no public transition history exists", () => {
    render(<UptimeBar transitions={[]} currentStatus="healthy" lastChangedAt={null} />);

    expect(screen.getByText("Status runway")).toBeTruthy();
    expect(screen.getByText("Daily posture over the last 30 days.")).toBeTruthy();
    expect(screen.getByText("Last 30d")).toBeTruthy();
    expect(screen.getByText("1d healthy · 29d no data")).toBeTruthy();
  });

  it("overlays only today with a live degradation when history is empty", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T12:00:00Z"));

    const { container } = render(<UptimeBar days={3} transitions={[]} currentStatus="degraded" lastChangedAt={null} />);

    expect(screen.getByText("1d degraded · 2d no data")).toBeTruthy();
    expect(container.querySelector('[title="2026-04-11: No probe."]')).toBeTruthy();
    expect(container.querySelector('[title="2026-04-13: Degraded"]')).toBeTruthy();
  });

  it("does not carry a stale segment forward after a coherent recovery transition", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T12:00:00Z"));

    render(
      <UptimeBar
        days={3}
        currentStatus="healthy"
        lastChangedAt={Date.parse("2026-04-12T12:00:00Z") / 1000}
        transitions={[
          {
            id: 2,
            from: "stale",
            to: "healthy",
            transitionType: "recover",
            reason: "raw-healthy-recovery-from-stale",
            at: Date.parse("2026-04-12T12:00:00Z") / 1000,
          },
          {
            id: 1,
            from: "healthy",
            to: "stale",
            transitionType: "degrade",
            reason: "raw-stale-immediate-escalation",
            at: Date.parse("2026-04-11T12:00:00Z") / 1000,
          },
        ]}
      />,
    );

    expect(screen.getByText("2d healthy · 1d stale")).toBeTruthy();
  });

  it("marks today degraded when live public health is worse than the transition stream", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T12:00:00Z"));

    const { container } = render(
      <UptimeBar
        days={3}
        currentStatus="degraded"
        lastChangedAt={null}
        transitions={[
          {
            id: 1,
            from: "degraded",
            to: "healthy",
            transitionType: "recover",
            reason: "raw-healthy-recovery",
            at: Date.parse("2026-04-11T12:00:00Z") / 1000,
          },
        ]}
      />,
    );

    expect(screen.getByText("2d healthy · 1d degraded")).toBeTruthy();
    expect(container.querySelector('[title="2026-04-13: Degraded"]')).toBeTruthy();
  });

  // The runway is built from UTC calendar days, so a DST-observing local zone
  // must not shift, duplicate, or drop a slot. A `+02:00` literal only fixes an
  // instant; the process timezone is what exercises local-calendar arithmetic.
  it.each([
    {
      name: "spring-forward Sunday",
      timeZone: "America/New_York",
      now: "2026-03-08T12:00:00Z",
      expected: ["2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08"],
    },
    {
      name: "fall-back Sunday inside the repeated local hour",
      timeZone: "America/New_York",
      now: "2026-11-01T05:30:00Z",
      expected: ["2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"],
    },
    {
      name: "UTC day already ahead of the local day",
      timeZone: "America/New_York",
      now: "2026-03-08T02:30:00Z",
      expected: ["2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08"],
    },
  ])("labels the runway with consecutive UTC days: $name", ({ timeZone, now, expected }) => {
    process.env.TZ = timeZone;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));

    const { container } = render(<UptimeBar days={4} transitions={[]} currentStatus="healthy" lastChangedAt={null} />);

    expect(runwayDates(container)).toEqual(expected);
  });

  it("ends the default runway on today's UTC day under a half-hour DST offset", () => {
    process.env.TZ = "Australia/Lord_Howe";
    vi.useFakeTimers();
    // 00:30 local on 2026-04-06, still 2026-04-05 in UTC.
    vi.setSystemTime(new Date("2026-04-05T13:30:00Z"));

    const { container } = render(<UptimeBar transitions={[]} currentStatus="healthy" lastChangedAt={null} />);

    const dates = runwayDates(container);
    expect(dates).toHaveLength(30);
    expect(dates[0]).toBe("2026-03-07");
    expect(dates.at(-1)).toBe("2026-04-05");
    expect(new Set(dates).size).toBe(30);
  });
});
