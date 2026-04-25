// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { LighthouseLensModel } from "./story-model";
import { LensRoomPanel } from "./lens-room-panel";

afterEach(() => cleanup());

const lens: LighthouseLensModel = {
  score: 72,
  band: "STEADY",
  scoreLabel: "STEADY 72.0",
  lightReachPct: 72,
  computedAt: 1710000000,
  methodologyVersion: "v1",
  caveat: "Lens caveat",
  slats: [
    {
      key: "severity",
      label: "Severity",
      value: 18,
      widthPct: 45,
      copy: "Severity copy",
    },
    {
      key: "breadth",
      label: "Breadth",
      value: 11,
      widthPct: 28,
      copy: "Breadth copy",
    },
  ],
};

describe("LensRoomPanel", () => {
  it("renders PSI score, methodology, and component slats", () => {
    render(<LensRoomPanel lens={lens} />);

    expect(screen.getByText("STEADY 72.0")).toBeTruthy();
    expect(screen.getByText(/Methodology v1/)).toBeTruthy();
    expect(screen.getByText("Severity")).toBeTruthy();
    expect(screen.getByText("18.0")).toBeTruthy();
    expect(screen.getByText("Lens caveat")).toBeTruthy();
  });

  it("renders an unavailable state when PSI is missing", () => {
    render(<LensRoomPanel lens={null} />);
    expect(screen.getByText(/PSI is unavailable/i)).toBeTruthy();
  });
});
