// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { LighthouseStormModel } from "./story-model";
import { StormWatchPanel } from "./storm-watch-panel";

afterEach(() => cleanup());

const storm: LighthouseStormModel = {
  warning: 2,
  alert: 1,
  danger: 1,
  totalPressure: 4,
  malformedRows: 1,
  updatedAt: 1710000100,
  oldestComputedAt: 1710000000,
  caveat: "Aggregate caveat",
};

describe("StormWatchPanel", () => {
  it("renders aggregate DEWS pressure counts", () => {
    render(<StormWatchPanel storm={storm} />);

    expect(screen.getByText("Warning")).toBeTruthy();
    expect(screen.getByText("Alert")).toBeTruthy();
    expect(screen.getByText("Danger")).toBeTruthy();
    expect(screen.getByText("4 non-calm signals")).toBeTruthy();
    expect(screen.getByText(/1 malformed stress rows/i)).toBeTruthy();
    expect(screen.getByText("Aggregate caveat")).toBeTruthy();
  });

  it("renders an unavailable state when stress data is missing", () => {
    render(<StormWatchPanel storm={null} />);
    expect(screen.getByText(/DEWS storm watch is unavailable/i)).toBeTruthy();
  });
});
