// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PSI_HEX_COLORS } from "@shared/lib/classification";
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

  it("draws no beam and no hue when unavailable", () => {
    const { root, svg } = renderBeacon({ ...LIVE, score: Number.NaN });
    expect(root.dataset.state).toBe("unavailable");
    expect(root.querySelector('[data-testid="psi-beacon-beam"]')).toBeNull();
    expect(root.querySelector('[data-testid="psi-beacon-avg-tick"]')).toBeNull();
    expect(root.style.getPropertyValue("--beam")).toBe("");
    expect(svg.getAttribute("aria-label")).toContain("PSI unavailable");
    expect(svg.textContent).toContain("No current reading");
  });

});

describe("PsiBeaconMicro", () => {
  it("draws an outline when retained", () => {
    const { container } = render(<PsiBeaconMicro score={50} retained />);
    expect(container.querySelector("rect")?.getAttribute("fill")).toBe("none");
  });
});
