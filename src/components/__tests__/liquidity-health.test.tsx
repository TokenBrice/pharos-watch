// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LiquidityHealthSchema } from "@shared/types/status/yield-liquidity";
import { LiquidityHealthCard } from "@/components/status/liquidity-health";

const classes = { primary: 0, mixed: 0, fallback: 0, legacy: 0, unobserved: 0 };
const bootstrap = {
  lastRunStatus: "ok", currentCoverage: 1, previousCoverage: 0,
  currentGlobalTvl: 100, previousGlobalTvl: null,
  currentTop10CoveredTvl: 0, previousTop10CoveredTvl: 0,
  currentTop10GuardTvl: 0, previousTop10GuardTvl: 0,
  failedSources: [], nearCoverageGuard: false, nearValueGuard: false, nearMajorCoverageGuard: false,
  currentCoverageClasses: { ...classes, primary: 1 }, previousCoverageClasses: classes,
  baselineReadFailures: [],
};

describe("liquidity baseline presentation", () => {
  it("renders failed prior evidence as unavailable instead of zero", () => {
    const health = LiquidityHealthSchema.parse({ ...bootstrap, lastRunStatus: "degraded",
      previousCoverage: null, previousCoverageClasses: null,
      currentTop10CoveredTvl: null, previousTop10CoveredTvl: null,
      currentTop10GuardTvl: null, previousTop10GuardTvl: null,
      baselineReadFailures: ["top-ten-read-failed", "coverage-classes-read-failed"],
    });
    render(<LiquidityHealthCard health={health} />);
    const previous = within(screen.getByText("Previous coverage mix").parentElement!);
    expect(previous.getByText("Unavailable")).toBeTruthy();
    expect(previous.queryByText("0")).toBeNull();
    expect(screen.getByText(/top-ten-read-failed/)).toBeTruthy();
    expect(screen.getAllByText("prev unavailable")).toHaveLength(3);
  });

  it("retains observed zero in a successful empty bootstrap", () => {
    render(<LiquidityHealthCard health={LiquidityHealthSchema.parse(bootstrap)} />);
    const previous = within(screen.getByText("Previous coverage mix").parentElement!);
    expect(previous.queryByText("Unavailable")).toBeNull();
    expect(previous.getAllByText("0")).toHaveLength(4);
    expect(screen.getByText("prev 0")).toBeTruthy();
    expect(screen.queryByText(/Baseline evidence unavailable/)).toBeNull();
  });
});
