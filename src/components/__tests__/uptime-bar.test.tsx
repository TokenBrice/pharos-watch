// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UptimeBar } from "@/components/status/uptime-bar";

afterEach(() => {
  vi.useRealTimers();
});

describe("UptimeBar", () => {
  it("renders pre-init days as No probe instead of backfilling the init status", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T12:00:00Z"));

    const { container } = render(
      <UptimeBar
        days={5}
        currentStatus="healthy"
        lastChangedAt={Date.parse("2026-09-14T12:00:00Z") / 1000}
        transitions={[
          {
            id: 1,
            from: null,
            to: "healthy",
            transitionType: "init",
            reason: "First probe",
            at: Date.parse("2026-09-14T12:00:00Z") / 1000,
          },
        ]}
      />,
    );

    expect(container.querySelector('[title="2026-09-12: No probe."]')).not.toBeNull();
    expect(container.querySelector('[title="2026-09-13: No probe."]')).not.toBeNull();
    expect(container.querySelector('[title="2026-09-14: Healthy"]')).not.toBeNull();
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("2d no data");
  });
});
