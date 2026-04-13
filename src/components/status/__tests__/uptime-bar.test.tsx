// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { UptimeBar } from "../uptime-bar";

describe("UptimeBar", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("labels the public runway as a fixed 30-day summary by default", () => {
    render(
      <UptimeBar
        transitions={[]}
        currentStatus="healthy"
        lastChangedAt={null}
      />,
    );

    expect(screen.getByText("Status runway")).toBeTruthy();
    expect(screen.getByText("Daily posture over the last 30 days.")).toBeTruthy();
    expect(screen.getByText("Last 30d")).toBeTruthy();
    expect(screen.getByText("100% healthy over the last 30 days")).toBeTruthy();
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
});
