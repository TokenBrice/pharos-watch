// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { resolveThresholdGaugeDomain, ShareMeter, ThresholdGauge, thresholdGaugePosition } from "../threshold-gauge";

function gauge(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>('[role="img"]')!;
}

function leftOf(element: Element | null): number {
  return Number.parseFloat((element as HTMLElement).style.left);
}

/** Drawn ticks in DOM order, excluding the value knob. */
function tickKinds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-gauge-marker]"))
    .map((element) => element.getAttribute("data-gauge-marker")!)
    .filter((kind) => kind !== "value");
}

function knobLeft(valuePct: number): number {
  const { container } = render(<ThresholdGauge valuePct={valuePct} ariaLabel="Collateral ratio" showValueLabel={false} />);
  return leftOf(container.querySelector('[data-gauge-marker="value"]'));
}

function scaleEnds(container: HTMLElement): { minPct: number; maxPct: number } {
  const read = (kind: string) =>
    Number.parseFloat(container.querySelector(`[data-gauge-label="${kind}"]`)!.textContent!.replace(/,/g, ""));
  return { minPct: read("scale-min"), maxPct: read("scale-max") };
}

describe("ThresholdGauge", () => {
  it.each([null, Number.NaN, -5])("draws %s as unavailable: no fill, no knob, named in the label", (valuePct) => {
    const { container } = render(<ThresholdGauge valuePct={valuePct} ariaLabel="Collateral ratio" />);
    const root = gauge(container);

    expect(root.getAttribute("data-state")).toBe("unavailable");
    expect(root.hasAttribute("data-tone")).toBe(false);
    expect(container.querySelector("[data-gauge-fill]")).toBeNull();
    expect(container.querySelector('[data-gauge-marker="value"]')).toBeNull();
    expect(container.querySelector('[data-gauge-label="unavailable"]')).not.toBeNull();
    expect(root.getAttribute("aria-label")).toMatch(/unavailable/i);
    // Par stays marked even without a ratio.
    expect(tickKinds(container)).toEqual(["par"]);
  });

  it.each([
    [96.4, "under"],
    [99.2, "under"],
    [100.2, "par"],
    [279.2, "over"],
  ])("tones %s %% as %s", (valuePct, tone) => {
    const { container } = render(<ThresholdGauge valuePct={valuePct} ariaLabel="Collateral ratio" />);
    expect(gauge(container).getAttribute("data-tone")).toBe(tone);
    expect(container.querySelector("[data-gauge-fill]")).not.toBeNull();
  });

  it("places par, threshold and shutdown in ratio order, with the value beyond them", () => {
    const { container } = render(
      <ThresholdGauge
        valuePct={279.2}
        ariaLabel="Collateral ratio"
        shutdown={{ pct: 150, label: "Shutdown" }}
        threshold={{ pct: 110, label: "MCR" }}
      />,
    );

    expect(tickKinds(container)).toEqual(["par", "threshold", "shutdown"]);
    const lefts = ["par", "threshold", "shutdown", "value"].map((kind) =>
      leftOf(container.querySelector(`[data-gauge-marker="${kind}"]`)),
    );
    expect(lefts).toEqual([...lefts].sort((a, b) => a - b));
    expect(new Set(lefts).size).toBe(lefts.length);
    // The knob and the fill end agree.
    expect(Number.parseFloat(container.querySelector<HTMLElement>("[data-gauge-fill]")!.style.width)).toBe(lefts[3]);
  });

  it("puts labels of neighbouring markers on separate lanes", () => {
    // On the 75–200 % track par and a 110 % MCR sit ~10 % of the track apart.
    const { container } = render(
      <ThresholdGauge
        valuePct={140}
        ariaLabel="Collateral ratio"
        threshold={{ pct: 110, label: "MCR" }}
        shutdown={{ pct: 150, label: "Shutdown" }}
      />,
    );
    const top = (kind: string) => container.querySelector<HTMLElement>(`[data-gauge-label="${kind}"]`)!.style.top;
    expect(top("par")).not.toBe(top("threshold"));
  });

  it("names markers a few pixels apart in one label, in track order, instead of stacking two", () => {
    // On the 50–1,000 % track par and a 110 % MCR land ~3 % of the track apart.
    const { container } = render(
      <ThresholdGauge valuePct={279.2} ariaLabel="Collateral ratio" threshold={{ pct: 110, label: "Lowest MCR" }} />,
    );
    const par = container.querySelector('[data-gauge-label~="par"]');
    expect(par).not.toBeNull();
    expect(container.querySelector('[data-gauge-label~="threshold"]')).toBe(par);
    const text = par!.textContent!;
    expect(text.indexOf("Par 100%")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Lowest MCR 110%")).toBeGreaterThan(text.indexOf("Par 100%"));
    // Both ticks stay drawn, and the accessible name still lists each marker.
    expect(tickKinds(container)).toEqual(["par", "threshold"]);
    expect(gauge(container).getAttribute("aria-label")).toContain("Lowest MCR 110%");
  });

  it("keeps 100 % to 1,000 % on the track, unclamped and in order", () => {
    const ratios = [100, 279.2, 419.8, 744.9, 1000];
    const positions = ratios.map((pct) => thresholdGaugePosition(pct));
    expect(positions.every((position) => position.clamped === null)).toBe(true);
    const lefts = positions.map((position) => position.left);
    expect(lefts).toEqual([...lefts].sort((a, b) => a - b));
    expect(new Set(lefts).size).toBe(lefts.length);
  });

  it("clamps a very large ratio to the track end while naming the true figure", () => {
    const { container } = render(<ThresholdGauge valuePct={25_000} ariaLabel="Collateral ratio" />);
    const root = gauge(container);

    expect(root.getAttribute("data-clamped")).toBe("high");
    expect(leftOf(container.querySelector('[data-gauge-marker="value"]'))).toBe(100);
    expect(root.getAttribute("aria-label")).toContain("25,000%");
    expect(container.querySelector('[data-gauge-label="value"]')!.textContent).toContain("25,000%");
  });

  it("clamps a ratio below the domain to the start without hiding the fill", () => {
    const { container } = render(<ThresholdGauge valuePct={12} ariaLabel="Collateral ratio" />);
    const root = gauge(container);

    expect(root.getAttribute("data-clamped")).toBe("low");
    expect(root.getAttribute("data-tone")).toBe("under");
    expect(leftOf(container.querySelector('[data-gauge-marker="value"]'))).toBe(0);
    expect(Number.parseFloat(container.querySelector<HTMLElement>("[data-gauge-fill]")!.style.width)).toBeGreaterThan(0);
  });

  it("separates ratios just above par from par itself", () => {
    // On the wide 50–1,000 % track these two knobs land under a pixel apart.
    expect(knobLeft(103) - knobLeft(100)).toBeGreaterThanOrEqual(5);
  });

  it("labels both ends of the track it draws, and puts par at its true place on them", () => {
    const { container } = render(<ThresholdGauge valuePct={103} ariaLabel="Collateral ratio" />);
    const ends = scaleEnds(container);

    expect(ends.minPct).toBeLessThan(100);
    expect(ends.maxPct).toBeGreaterThan(103);
    expect(leftOf(container.querySelector('[data-gauge-marker="par"]'))).toBe(thresholdGaugePosition(100, ends).left);
    expect(gauge(container).getAttribute("aria-label")).toContain(`from ${ends.minPct}% to ${ends.maxPct}%`);
  });

  it("widens the track until every reviewed marker and the ratio fit unclamped", () => {
    const { container } = render(
      <ThresholdGauge
        valuePct={140}
        ariaLabel="Collateral ratio"
        threshold={{ pct: 110, label: "MCR" }}
        shutdown={{ pct: 150, label: "Shutdown" }}
      />,
    );
    const ends = scaleEnds(container);

    expect(gauge(container).hasAttribute("data-clamped")).toBe(false);
    expect(ends.minPct).toBeLessThan(100);
    expect(ends.maxPct).toBeGreaterThan(150);
    for (const kind of ["par", "threshold", "shutdown", "value"]) {
      const left = leftOf(container.querySelector(`[data-gauge-marker="${kind}"]`));
      expect(left, kind).toBeGreaterThan(0);
      expect(left, kind).toBeLessThan(100);
    }
  });

  it("zooms tighter the closer the ratio sits to par", () => {
    const span = (pct: number) => {
      const { minPct, maxPct } = resolveThresholdGaugeDomain([pct, 100]);
      return maxPct / minPct;
    };
    expect(span(103)).toBeLessThan(span(160));
    expect(span(160)).toBeLessThan(span(279.2));
    for (const pct of [92, 103, 124, 160, 279.2, 744.9]) {
      expect(thresholdGaugePosition(pct, resolveThresholdGaugeDomain([pct, 100])).clamped, String(pct)).toBeNull();
    }
  });
});

describe("ShareMeter", () => {
  it("separates an unavailable share from a measured zero", () => {
    const unavailable = render(<ShareMeter valuePct={null} ariaLabel="Liquidation backstop" />).container;
    expect(gauge(unavailable).getAttribute("data-state")).toBe("unavailable");
    expect(unavailable.querySelector("[data-gauge-fill]")).toBeNull();

    const zero = render(<ShareMeter valuePct={0} ariaLabel="Liquidation backstop" />).container;
    expect(gauge(zero).getAttribute("data-state")).toBe("available");
    expect(gauge(zero).getAttribute("aria-label")).toContain("0%");
  });

  it.each([
    [57.5, 57.5],
    [140, 100],
  ])("fills %s %% of supply to %s %% of the track", (valuePct, width) => {
    const { container } = render(<ShareMeter valuePct={valuePct} ariaLabel="Liquidation backstop" />);
    expect(Number.parseFloat(container.querySelector<HTMLElement>("[data-gauge-fill]")!.style.width)).toBe(width);
    expect(gauge(container).getAttribute("aria-label")).toContain(`${valuePct}%`);
  });
});
