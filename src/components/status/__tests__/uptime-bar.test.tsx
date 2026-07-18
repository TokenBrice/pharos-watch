// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { UptimeBar } from "../uptime-bar";

describe("UptimeBar", () => {
  afterEach(() => {
    vi.useRealTimers();
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

  it("keeps runway dates unique across daylight-saving transitions", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T01:53:00+02:00"));

    const { container } = render(<UptimeBar transitions={[]} currentStatus="healthy" lastChangedAt={null} />);

    const dates = Array.from(container.querySelectorAll("[title]"), (node) => node.getAttribute("title")?.slice(0, 10));

    expect(dates).toHaveLength(30);
    expect(new Set(dates).size).toBe(30);
  });
});
