// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PSI_HEX_COLORS, PSI_UNKNOWN_BAND_HEX } from "@shared/lib/classification";
import { derivePsiBeaconState, type PsiBeaconCurrentLike } from "@shared/lib/psi-beacon";
import { PsiBeacon } from "./psi-beacon";
import { PsiBeaconMicro } from "./psi-beacon-micro";

const LIVE: PsiBeaconCurrentLike = {
  score: 91.9,
  band: "BEDROCK",
  avg24h: 92.1,
  avg24hBand: "BEDROCK",
  computedAt: 1791782781,
  components: { severity: 0.02, breadth: 6.65, stressBreadth: 1.33, trend: -0.14 },
};

function renderBeacon(current: PsiBeaconCurrentLike | null, isFresh = true, extra: { isLoading?: boolean } = {}) {
  const state = derivePsiBeaconState({ current, isFresh, healthMessage: "Data is stale.", asOfLabel: "Oct 12, 2:32 PM", ...extra });
  const { container } = render(<PsiBeacon state={state} />);
  const root = container.querySelector<HTMLElement>('[data-testid="psi-beacon"]');
  const svg = root?.querySelector("svg[role='img']");
  if (!root || !svg) throw new Error("beacon not rendered");
  return { root, svg, container };
}

describe("PsiBeacon", () => {
  it("names the full reading and exposes the state", () => {
    const { root, svg } = renderBeacon(LIVE);
    expect(root.dataset.state).toBe("current");
    expect(root.dataset.paint).toBe("lit");
    expect(root.style.getPropertyValue("--beam")).toBe(PSI_HEX_COLORS.BEDROCK);
    expect(svg.getAttribute("aria-label")).toBe(
      "Pharos Stability Index lighthouse: instant 91.9 BEDROCK; light lost to severity 0.0, breadth 6.7, stress breadth 1.3; trend −0.1; 24h average 92.1.",
    );
  });

  it("draws the beam, one fog bank per nonzero penalty, the drag and the avg tick", () => {
    const { root } = renderBeacon(LIVE);
    expect(root.querySelector('[data-testid="psi-beacon-beam"]')).not.toBeNull();
    for (const key of ["severity", "breadth", "stressBreadth"]) {
      expect(root.querySelector(`[data-testid="psi-beacon-fog-${key}"]`)).not.toBeNull();
    }
    expect(root.querySelector('[data-testid="psi-beacon-drag"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="psi-beacon-avg-tick"]')?.textContent).toBe("24h avg 92.1");
    expect(root.querySelector('[data-testid="psi-beacon-fog-severity"] title')?.textContent).toContain("<0.3");
  });

  it("prints component values at the panels' one-decimal precision", () => {
    const legend = renderBeacon(LIVE).root.querySelector('[data-testid="psi-beacon-legend"]')!.textContent;
    expect(legend).toContain("instant91.9");
    expect(legend).toContain("severity0.0");
    expect(legend).toContain("breadth6.7");
    expect(legend).toContain("stress breadth1.3");
    expect(legend).toContain("trend−0.1");
    expect(legend).toContain("24h avg92.1");
  });

  it("omits the avg tick without a 24h average", () => {
    const { root } = renderBeacon({ ...LIVE, avg24h: undefined, avg24hBand: undefined });
    expect(root.querySelector('[data-testid="psi-beacon-avg-tick"]')).toBeNull();
  });

  it("shows a null component as unknown, not zero", () => {
    const { root } = renderBeacon({ ...LIVE, components: { ...LIVE.components!, breadth: null } });
    expect(root.querySelector('[data-testid="psi-beacon-fog-breadth"]')).toBeNull();
    expect(root.querySelector('[data-testid="psi-beacon-unknown"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="psi-beacon-legend"]')!.textContent).toContain("breadthn/a");
  });

  it("drops the hue when retained and names the as-of", () => {
    const { root, svg } = renderBeacon(LIVE, false);
    expect(root.dataset.state).toBe("retained");
    expect(root.dataset.paint).toBe("outline");
    expect(root.style.getPropertyValue("--beam")).toBe(PSI_UNKNOWN_BAND_HEX);
    expect(root.querySelector('[data-testid="psi-beacon-lamp"]')).toBeNull();
    expect(svg.getAttribute("aria-label")).toMatch(/^Retained observation as of Oct 12, 2:32 PM, not current\./);
    expect(svg.textContent).toContain("Retained · as of Oct 12, 2:32 PM");
    expect(root.innerHTML).not.toContain(PSI_HEX_COLORS.BEDROCK);
  });

  it("draws no beam and no hue when unavailable", () => {
    const { root, svg } = renderBeacon({ ...LIVE, score: Number.NaN });
    expect(root.dataset.state).toBe("unavailable");
    expect(root.querySelector('[data-testid="psi-beacon-beam"]')).toBeNull();
    expect(root.querySelector('[data-testid="psi-beacon-avg-tick"]')).toBeNull();
    expect(root.style.getPropertyValue("--beam")).toBe("");
    expect(svg.getAttribute("aria-label")).toContain("PSI unavailable");
    expect(svg.textContent).toContain("No current reading");
  });

  it("marks loading busy with no beam", () => {
    const { root, svg } = renderBeacon(null, false, { isLoading: true });
    expect(root.dataset.state).toBe("loading");
    expect(svg.getAttribute("aria-busy")).toBe("true");
    expect(root.querySelector('[data-testid="psi-beacon-beam"]')).toBeNull();
  });

  it("has no animation or transition hooks (fully static)", () => {
    const { container } = renderBeacon(LIVE);
    expect(container.querySelector("animate, animateTransform, [style*='animation']")).toBeNull();
  });
});

describe("PsiBeaconMicro", () => {
  it("is decorative and lights the track to the score", () => {
    const { container } = render(<PsiBeaconMicro score={50} retained={false} />);
    const svg = container.querySelector('[data-testid="psi-beacon-micro"]')!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.querySelector("rect")?.getAttribute("width")).toBe("15");
    expect(svg.querySelector("rect")?.getAttribute("fill")).toBe("currentColor");
  });

  it("draws an outline when retained", () => {
    const { container } = render(<PsiBeaconMicro score={50} retained />);
    expect(container.querySelector("rect")?.getAttribute("fill")).toBe("none");
  });
});
