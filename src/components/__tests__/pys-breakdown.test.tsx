// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PysBreakdown, type PysBreakdownProps } from "@/components/pys-breakdown";
import { TooltipProvider } from "@/components/ui/tooltip";
import { formatSignedPysDelta } from "@/lib/yield-presentation";
import {
  YIELD_METHODOLOGY_CHANGELOG_PATH,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/yield-methodology";
import {
  PYS_DEFAULT_SAFETY_SCORE,
  PYS_MAX_SOURCE_RISK_PENALTY,
  PYS_SUSTAINABILITY_FLOOR,
  computePYS,
} from "@shared/lib/yield-scoring";
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
    scalingFactor: 1,
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

  describe("per-factor PYS deltas", () => {
    // Pick a scenario where every factor has a measurable contribution. Numbers
    // are chosen so the analytical and rendered deltas align cleanly.
    const factorScenario = {
      apy30d: 12,
      safetyScore: 60,
      apyVarianceScore: 0.4, // sustainabilityMult = 0.6
      // WHY: scalingFactor > 1 keeps neutralized scores away from the 0/100
      // clamp so each factor produces a measurable delta.
      scalingFactor: 30,
      benchmarkRate: 4,
      sourceRiskPenalty: 1.5,
    };

    function renderForFactors(score: number) {
      // Effective yield = apy30d + 0.25 * (apy30d - benchmarkRate)
      //                 = 12 + 0.25 * 8 = 14
      // safetyScore = 60 -> riskPenalty = (101 - 60)/20 = 2.05 -> adjusted ≈ 2.05^1.75
      // sustainabilityMult = 1 - 0.4 = 0.6
      return renderWithProvider(
        baseProps({
          mode: "popover", // avoid the <details> wrapper and any tooltip nesting
          score,
          apy30d: factorScenario.apy30d,
          effectiveYield: 14,
          benchmarkAdjustment: 2,
          benchmarkSpread: 8,
          benchmarkLabel: "SOFR",
          sourceRiskPenalty: factorScenario.sourceRiskPenalty,
          adjustedRiskPenalty: Math.pow(2.05, 1.75),
          sustainabilityMult: 0.6,
          grade: "C",
          safetyScore: factorScenario.safetyScore,
          sourceRiskDrivers: [],
          scalingFactor: factorScenario.scalingFactor,
        }),
      );
    }

    it("renders signed PYS deltas next to each factor multiplier", () => {
      const actualScore = computePYS({
        apy30d: factorScenario.apy30d,
        safetyScore: factorScenario.safetyScore,
        apyVarianceScore: factorScenario.apyVarianceScore,
        scalingFactor: factorScenario.scalingFactor,
        benchmarkRate: factorScenario.benchmarkRate,
        sourceRiskPenalty: factorScenario.sourceRiskPenalty,
      });

      const sourceRiskNeutral = computePYS({
        apy30d: factorScenario.apy30d,
        safetyScore: factorScenario.safetyScore,
        apyVarianceScore: factorScenario.apyVarianceScore,
        scalingFactor: factorScenario.scalingFactor,
        benchmarkRate: factorScenario.benchmarkRate,
        sourceRiskPenalty: 1,
      });
      const safetyNeutral = computePYS({
        apy30d: factorScenario.apy30d,
        safetyScore: 100,
        apyVarianceScore: factorScenario.apyVarianceScore,
        scalingFactor: factorScenario.scalingFactor,
        benchmarkRate: factorScenario.benchmarkRate,
        sourceRiskPenalty: factorScenario.sourceRiskPenalty,
      });
      const sustainabilityNeutral = computePYS({
        apy30d: factorScenario.apy30d,
        safetyScore: factorScenario.safetyScore,
        apyVarianceScore: 0,
        scalingFactor: factorScenario.scalingFactor,
        benchmarkRate: factorScenario.benchmarkRate,
        sourceRiskPenalty: factorScenario.sourceRiskPenalty,
      });

      const expectedSourceRiskDelta = formatSignedPysDelta(actualScore - sourceRiskNeutral);
      const expectedSafetyDelta = formatSignedPysDelta(actualScore - safetyNeutral);
      const expectedSustainabilityDelta = formatSignedPysDelta(actualScore - sustainabilityNeutral);

      const { container } = renderForFactors(actualScore);

      const textContent = container.textContent ?? "";
      expect(textContent).toContain(`(${expectedSourceRiskDelta})`);
      expect(textContent).toContain(`(${expectedSafetyDelta})`);
      expect(textContent).toContain(`(${expectedSustainabilityDelta})`);

      // The neutralize deltas should each be non-zero in this scenario.
      expect(actualScore - sourceRiskNeutral).not.toBe(0);
      expect(actualScore - safetyNeutral).not.toBe(0);
      expect(actualScore - sustainabilityNeutral).not.toBe(0);
    });
  });

  describe("source-risk score suffix", () => {
    it("renders the suffix when sourceRiskScore prop is provided", () => {
      const { container } = renderWithProvider(
        baseProps({
          mode: "popover",
          sourceRiskPenalty: 1.5,
          sourceRiskScore: 42,
        }),
      );
      expect((container.textContent ?? "").includes("(42/100)")).toBe(true);
    });

    it("derives the suffix from sourceRiskPenalty when prop is omitted", () => {
      // 1.75 -> midpoint of [1, 2.5] -> 50
      const { container } = renderWithProvider(
        baseProps({
          mode: "popover",
          sourceRiskPenalty: 1.75,
        }),
      );
      expect((container.textContent ?? "").includes("(50/100)")).toBe(true);
    });

    it("omits the suffix when the penalty is non-finite", () => {
      // WHY: safety grade also renders "(N/100)" in its sublabel; null out
      // safetyScore + grade so the only "/100" check is the source-risk suffix.
      const { container } = renderWithProvider(
        baseProps({
          mode: "popover",
          sourceRiskPenalty: Number.NaN,
          sourceRiskScore: null,
          safetyScore: null,
          grade: null,
        }),
      );
      expect((container.textContent ?? "").includes("/100)")).toBe(false);
    });
  });

  describe("clamp badges", () => {
    it("renders the default-safety badge only when safetyScore is null", () => {
      const { container } = renderWithProvider(
        baseProps({ mode: "popover", safetyScore: null, grade: null }),
      );
      expect((container.textContent ?? "").includes(`default ${PYS_DEFAULT_SAFETY_SCORE}`)).toBe(true);
      expect(
        screen.getByLabelText(`No safety grade available — defaulted to ${PYS_DEFAULT_SAFETY_SCORE}`),
      ).toBeTruthy();
    });

    it("omits the default-safety badge when safetyScore is provided", () => {
      const { container } = renderWithProvider(baseProps({ mode: "popover", safetyScore: 80 }));
      expect((container.textContent ?? "").includes(`default ${PYS_DEFAULT_SAFETY_SCORE}`)).toBe(false);
    });

    it("renders the sustainability floor badge only when sustainabilityMult equals the floor", () => {
      const { container } = renderWithProvider(
        baseProps({ mode: "popover", sustainabilityMult: PYS_SUSTAINABILITY_FLOOR }),
      );
      expect((container.textContent ?? "").includes("floor 30%")).toBe(true);
      expect(screen.getByLabelText("Consistency hit the methodology floor")).toBeTruthy();
    });

    it("omits the sustainability floor badge when multiplier is above the floor", () => {
      const { container } = renderWithProvider(
        baseProps({ mode: "popover", sustainabilityMult: 0.8 }),
      );
      expect((container.textContent ?? "").includes("floor 30%")).toBe(false);
    });

    it("renders the source-risk clamp badge only when penalty equals the max", () => {
      const { container } = renderWithProvider(
        baseProps({ mode: "popover", sourceRiskPenalty: PYS_MAX_SOURCE_RISK_PENALTY }),
      );
      expect((container.textContent ?? "").includes("cap 2.5×")).toBe(true);
      expect(screen.getByLabelText("Source-risk penalty hit the methodology cap")).toBeTruthy();
    });

    it("omits the source-risk clamp badge when penalty is below the max", () => {
      const { container } = renderWithProvider(
        baseProps({ mode: "popover", sourceRiskPenalty: 1.2 }),
      );
      expect((container.textContent ?? "").includes("cap 2.5×")).toBe(false);
    });

    it("renders the benchmark-fallback badge only when benchmarkSelectionMode is fallback-usd", () => {
      const { container } = renderWithProvider(
        baseProps({ mode: "popover", benchmarkSelectionMode: "fallback-usd" }),
      );
      expect((container.textContent ?? "").includes("USD fallback")).toBe(true);
      expect(screen.getByLabelText("Benchmark resolved via USD fallback")).toBeTruthy();
    });

    it("omits the benchmark-fallback badge for native mode", () => {
      const { container } = renderWithProvider(
        baseProps({ mode: "popover", benchmarkSelectionMode: "native" }),
      );
      expect((container.textContent ?? "").includes("USD fallback")).toBe(false);
    });

    it("uses inline-mode tooltip wrapping for clamp badges", () => {
      // In inline mode, ClampBadge wraps with Tooltip — the badge element must
      // be a child of the tooltip trigger and carry cursor-help, not just a title.
      renderWithProvider(baseProps({ mode: "inline", sourceRiskPenalty: PYS_MAX_SOURCE_RISK_PENALTY }));
      const trigger = screen.getByLabelText("Source-risk penalty hit the methodology cap");
      expect(trigger).toBeTruthy();
      expect(trigger.className).toContain("cursor-help");
      expect(trigger.getAttribute("title")).toBeNull();
    });

    it("uses title-only badges in popover mode to avoid nested tooltips", () => {
      renderWithProvider(baseProps({ mode: "popover", sourceRiskPenalty: PYS_MAX_SOURCE_RISK_PENALTY }));
      const badge = screen.getByLabelText("Source-risk penalty hit the methodology cap");
      expect(badge.getAttribute("title")).toBe("Source-risk penalty hit the methodology cap");
    });
  });
});
