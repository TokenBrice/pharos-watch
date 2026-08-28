// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PSI_HEX_COLORS, type ConditionBand } from "@shared/lib/psi-colors";
import { PsiLighthouseScene } from "./psi-lighthouse-scene";

const BANDS: ConditionBand[] = ["BEDROCK", "STEADY", "TREMOR", "FRACTURE", "CRISIS", "MELTDOWN"];

function renderScene(band: ConditionBand, score: number) {
  const { container } = render(<PsiLighthouseScene band={band} score={score} />);
  const svg = container.querySelector<SVGSVGElement>('[data-testid="psi-lighthouse-scene"]');
  if (!svg) throw new Error("scene svg not rendered");
  return { container, svg };
}

describe("PsiLighthouseScene", () => {
  it("renders a labeled img role svg with band and score exposed in data attributes", () => {
    const { svg } = renderScene("BEDROCK", 92);
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toContain("BEDROCK");
    expect(svg.getAttribute("aria-label")).toContain("92");
    expect(svg.getAttribute("preserveAspectRatio")).toBe("xMidYMid meet");
    expect(svg.dataset.band).toBe("BEDROCK");
    expect(svg.dataset.score).toBe("92");
  });

  it("gives the rightward beam overscan room inside the viewBox", () => {
    const { svg } = renderScene("BEDROCK", 100);
    const [minX, minY, width] = (svg.getAttribute("viewBox") ?? "")
      .split(/\s+/)
      .map(Number);
    expect(minX).toBe(0);
    expect(minY).toBeLessThan(0);
    expect(width).toBeGreaterThan(280);
  });

  it.each(BANDS)("colors flames with PSI_HEX_COLORS for band %s", (band) => {
    const { container } = renderScene(band, 80);
    const flames = container.querySelector('[data-testid="psi-scene-flames"]');
    expect(flames).toBeTruthy();
    const fills = Array.from(flames?.querySelectorAll("path") ?? []).map((p) => p.getAttribute("fill"));
    expect(fills.every((f) => f === PSI_HEX_COLORS[band])).toBe(true);
  });

  it("beam wedge reaches farther at score 100 than at score 0", () => {
    const low = renderScene("MELTDOWN", 0);
    const high = renderScene("BEDROCK", 100);

    const primaryLow = low.container.querySelector<SVGPathElement>('[data-testid="psi-scene-beam-primary"]');
    const primaryHigh = high.container.querySelector<SVGPathElement>('[data-testid="psi-scene-beam-primary"]');
    expect(primaryLow?.getAttribute("d")).toBeTruthy();
    expect(primaryHigh?.getAttribute("d")).toBeTruthy();
    expect(primaryLow?.getAttribute("d")).not.toBe(primaryHigh?.getAttribute("d"));

    // Opacity grows with score
    const lowOpacity = Number(primaryLow?.getAttribute("opacity") ?? "0");
    const highOpacity = Number(primaryHigh?.getAttribute("opacity") ?? "0");
    expect(highOpacity).toBeGreaterThan(lowOpacity);
  });

  it("flame group scales larger at score 100 than at score 0", () => {
    const low = renderScene("MELTDOWN", 0);
    const high = renderScene("BEDROCK", 100);
    const flamesLow = low.container.querySelector<SVGGElement>('[data-testid="psi-scene-flames"]');
    const flamesHigh = high.container.querySelector<SVGGElement>('[data-testid="psi-scene-flames"]');

    const lowT = flamesLow?.getAttribute("transform") ?? "";
    const highT = flamesHigh?.getAttribute("transform") ?? "";
    const lowScale = Number((/scale\(([\d.]+)\)/.exec(lowT) ?? [])[1]);
    const highScale = Number((/scale\(([\d.]+)\)/.exec(highT) ?? [])[1]);
    expect(lowScale).toBeGreaterThan(0);
    expect(highScale).toBeGreaterThan(lowScale);
  });

  it("clamps out-of-range scores without crashing", () => {
    expect(() => renderScene("STEADY", -50)).not.toThrow();
    expect(() => renderScene("STEADY", 250)).not.toThrow();
    expect(() => renderScene("STEADY", Number.NaN)).not.toThrow();
  });

  it("falls back to neutral styling for an unknown band", () => {
    const { container } = render(<PsiLighthouseScene band="UNKNOWN" score={50} />);
    const svg = container.querySelector<SVGSVGElement>('[data-testid="psi-lighthouse-scene"]');
    expect(svg).toBeTruthy();
    const flames = svg?.querySelector('[data-testid="psi-scene-flames"]');
    const firstFlameFill = flames?.querySelector("path")?.getAttribute("fill");
    expect(firstFlameFill).toBe("#888");
  });
});
