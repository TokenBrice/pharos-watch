// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { DepthGauge } from "./depth-gauge";

afterEach(() => cleanup());

describe("DepthGauge", () => {
  it("renders a dry cylinder (dashed walls, no water) when score is null", () => {
    const { container } = render(createElement(DepthGauge, {
      score: null,
      coverageClass: null,
      volume24hUsd: 0,
      organicFraction: null,
      symbol: "DRY",
      patternId: "dry-test",
    }));
    const cylinder = container.querySelector("svg rect");
    expect(cylinder?.getAttribute("stroke-dasharray")).toBe("4 3");
    // No water fill path in dry mode
    const waterFills = container.querySelectorAll("svg > rect[fill]:not([fill='none'])");
    expect(waterFills.length).toBe(0);
    // Aria-label announces unrated
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-label")).toContain("unrated");
  });

  it("renders a dry cylinder when coverageClass is 'unobserved' (regardless of score)", () => {
    const { container } = render(createElement(DepthGauge, {
      score: 80,
      coverageClass: "unobserved" as const,
      volume24hUsd: 0,
      organicFraction: null,
      symbol: "OBS",
      patternId: "obs-test",
    }));
    const cylinder = container.querySelector("svg rect");
    expect(cylinder?.getAttribute("stroke-dasharray")).toBe("4 3");
  });

  it("renders a filled water column for a rated gauge with primary coverage", () => {
    const { container } = render(createElement(DepthGauge, {
      score: 60,
      coverageClass: "primary" as const,
      volume24hUsd: 5_000_000,
      organicFraction: 0.9,
      symbol: "USDC",
      patternId: "usdc-test",
    }));
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-label")).toContain("depth 60 of 100");
    expect(svg?.getAttribute("aria-label")).toContain("primary coverage");
    // Cylinder walls are solid (no dasharray) for rated gauges
    const cylinder = svg?.querySelector("rect");
    expect(cylinder?.getAttribute("stroke-dasharray")).toBeFalsy();
  });
});
