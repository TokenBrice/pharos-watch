// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PysBreakdown, type PysBreakdownProps } from "@/components/pys-breakdown";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  YIELD_METHODOLOGY_CHANGELOG_PATH,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/yield-methodology-version";
import type { YieldPysNullReason } from "@shared/types";

function baseProps(overrides: Partial<PysBreakdownProps> = {}): PysBreakdownProps {
  return {
    mode: "inline",
    score: 50,
    toneClass: "text-foreground",
    apy30d: 5,
    effectiveYield: 4.5,
    benchmarkAdjustment: 0.5,
    benchmarkSpread: 2,
    benchmarkLabel: "SOFR",
    sourceRiskPenalty: 1,
    adjustedRiskPenalty: 1,
    sustainabilityMult: 0.9,
    grade: "A",
    safetyScore: 90,
    sourceRiskDrivers: [],
    ...overrides,
  };
}

function renderWithProvider(props: PysBreakdownProps) {
  return render(
    <TooltipProvider>
      <PysBreakdown {...props} />
    </TooltipProvider>,
  );
}

describe("PysBreakdown", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders score, breakdown lines, and methodology link with version label", () => {
    const { container } = renderWithProvider(baseProps({ mode: "inline", score: 50 }));

    // Score displayed in the inline summary (toFixed(1)).
    expect(container.textContent ?? "").toContain("50.0");

    // Core breakdown lines are present.
    expect(screen.getByLabelText(/Base APY 5.0 percent/)).toBeTruthy();
    expect(screen.getByLabelText(/Effective yield 4.5 percent/)).toBeTruthy();
    expect(screen.getByLabelText(/Divided by source-risk penalty 1.00 times/)).toBeTruthy();
    expect(screen.getByLabelText(/Divided by safety penalty 1.0 times/)).toBeTruthy();
    expect(screen.getByLabelText(/Multiplied by consistency 90 percent/)).toBeTruthy();

    // Methodology link points at the changelog and exposes the version label.
    const link = screen.getByRole("link", {
      name: `Yield methodology ${YIELD_METHODOLOGY_VERSION_LABEL} changelog`,
    });
    expect(link).toBeTruthy();
    // next/link with trailingSlash:true may emit href with or without the trailing slash.
    const expectedHref = YIELD_METHODOLOGY_CHANGELOG_PATH.replace(/\/$/, "");
    expect((link.getAttribute("href") ?? "").replace(/\/$/, "")).toBe(expectedHref);
    expect(link.textContent ?? "").toContain(`Methodology ${YIELD_METHODOLOGY_VERSION_LABEL}`);
    // Ensure the version label is not double-prefixed (e.g. "vv8.13").
    expect(link.textContent ?? "").not.toMatch(/vv\d/);
  });

  const nullReasonCases: ReadonlyArray<{ reason: YieldPysNullReason; expected: string }> = [
    { reason: "apy-non-positive", expected: "30-day APY is ≤ 0; PYS only scores positive yield." },
    {
      reason: "effective-yield-non-positive",
      expected: "Effective yield ≤ 0 after benchmark adjustment.",
    },
    { reason: "scaling-invalid", expected: "Scaling factor unavailable." },
    { reason: "missing-inputs", expected: "Required inputs missing for scoring." },
  ];

  it.each(nullReasonCases)(
    "exposes the $reason null reason via aria-label in inline mode",
    ({ reason, expected }) => {
      renderWithProvider(baseProps({ mode: "inline", score: null, pysNullReason: reason }));

      const trigger = screen.getByLabelText(`Pharos Yield Score unavailable: ${expected}`);
      expect(trigger).toBeTruthy();
      expect(trigger.textContent).toBe("—");
    },
  );

  it.each(nullReasonCases)(
    "exposes the $reason null reason via aria-label and title in popover mode",
    ({ reason, expected }) => {
      renderWithProvider(baseProps({ mode: "popover", score: null, pysNullReason: reason }));

      const trigger = screen.getByLabelText(`Pharos Yield Score unavailable: ${expected}`);
      expect(trigger).toBeTruthy();
      expect(trigger.getAttribute("title")).toBe(expected);
      expect(trigger.textContent).toBe("—");
    },
  );

  it("renders bare em dash with no tooltip when score is null and no nullReason is provided", () => {
    const { container } = renderWithProvider(baseProps({ mode: "inline", score: null }));

    // The only rendered content should be the dash; no tooltip trigger label and no title.
    expect(container.textContent).toBe("—");
    expect(screen.queryByLabelText(/Pharos Yield Score unavailable/)).toBeNull();
    const span = container.querySelector("span");
    expect(span).not.toBeNull();
    expect(span?.getAttribute("aria-label")).toBeNull();
    expect(span?.getAttribute("title")).toBeNull();
  });

  it("renders bare em dash with no tooltip when score is null and nullReason is explicitly null", () => {
    const { container } = renderWithProvider(
      baseProps({ mode: "popover", score: null, pysNullReason: null }),
    );

    expect(container.textContent).toBe("—");
    expect(screen.queryByLabelText(/Pharos Yield Score unavailable/)).toBeNull();
  });
});
