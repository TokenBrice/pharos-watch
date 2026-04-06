// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { UptimeBar } from "../uptime-bar";

describe("UptimeBar", () => {
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
});
