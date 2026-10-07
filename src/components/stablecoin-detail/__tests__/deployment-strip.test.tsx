// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import {
  BRIDGE_TIER_CELL_CLASSES,
  BRIDGE_TIER_DIAGNOSTIC_CELL_CLASSES,
  BRIDGE_TIER_POLICY_ORDER,
} from "@shared/lib/classification";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { BRIDGE_ROUTE_RISK_TIER_VALUES } from "@shared/types/core";
import { DeploymentStrip, type DeploymentStripCell } from "../deployment-strip";

function cell(key: string, overrides: Partial<DeploymentStripCell> = {}): DeploymentStripCell {
  return {
    key,
    label: `Chain ${key}`,
    tierKey: "external-lock-mint",
    tierLabel: `Tier of ${key}`,
    ...overrides,
  };
}

function cellKeysWith(container: HTMLElement, attribute: string): string[] {
  return Array.from(container.querySelectorAll(`[data-cell][${attribute}]`)).map(
    (element) => element.getAttribute("data-cell")!,
  );
}

function srItems(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("ul.sr-only:not([aria-label]) > li")).map((li) => li.textContent ?? "");
}

describe("DeploymentStrip", () => {
  it("falls back to equal widths with a caption unless every cell carries a weight", () => {
    const unweighted = render(<DeploymentStrip ariaLabel="Deployments" cells={[cell("a"), cell("b"), cell("c")]} />).container;
    expect(unweighted.querySelector('[data-widths="equal"]')).not.toBeNull();
    expect(unweighted.querySelector("[data-split-caption]")).not.toBeNull();

    const partial = render(
      <DeploymentStrip ariaLabel="Deployments" cells={[cell("a", { weight: 3 }), cell("b", { weight: null }), cell("c", { weight: 1 })]} />,
    ).container;
    expect(partial.querySelector('[data-widths="equal"]')).not.toBeNull();
    expect(partial.querySelector("[data-split-caption]")).not.toBeNull();

    const weighted = render(
      <DeploymentStrip ariaLabel="Deployments" cells={[cell("a", { weight: 3 }), cell("b", { weight: 0 }), cell("c", { weight: 1 })]} />,
    ).container;
    expect(weighted.querySelector('[data-widths="weighted"]')).not.toBeNull();
    expect(weighted.querySelector("[data-split-caption]")).toBeNull();
    // Weighted shares reach the accessible roster; equal widths claim none.
    expect(srItems(weighted)[0]).toContain("75.0%");
    expect(srItems(unweighted).some((item) => item.includes("%"))).toBe(false);
  });

  it("does not caption a single deployment", () => {
    const { container } = render(<DeploymentStrip ariaLabel="Deployments" cells={[cell("a", { home: true })]} />);
    expect(container.querySelector("[data-split-caption]")).toBeNull();
  });

  it("merges caller caveats and the equal-width note into one caveat line", () => {
    const { container } = render(
      <DeploymentStrip
        ariaLabel="Deployments"
        cells={[cell("a"), cell("b")]}
        caveats={["40 of 88 routes drawn in proportion", "2 of 6 shared failure domains bracketed"]}
      />,
    );
    const lines = container.querySelectorAll("[data-strip-caveats]");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.textContent).toMatch(/^40 of 88 routes drawn in proportion · 2 of 6 .+ · /);
    expect(lines[0]!.querySelector("[data-split-caption]")).not.toBeNull();
  });

  it("outlines only limiting cells, ties included", () => {
    const { container } = render(
      <DeploymentStrip
        ariaLabel="Deployments"
        cells={[
          cell("oracle", { role: "limiting" }),
          cell("mint", { role: "eligible" }),
          cell("bridge-1", { role: "diagnostic" }),
          cell("bridge-2"),
          cell("tie", { role: "limiting" }),
        ]}
      />,
    );
    expect(cellKeysWith(container, "data-outlined")).toEqual(["oracle", "tie"]);
  });

  it("draws no outline when every route is a diagnostic", () => {
    const cells = Array.from({ length: 31 }, (_, index) => cell(`oft-${index}`, { role: "diagnostic" }));
    const { container } = render(<DeploymentStrip ariaLabel="Deployments" cells={cells} />);
    expect(cellKeysWith(container, "data-outlined")).toEqual([]);
    expect(container.querySelectorAll("[data-cell]")).toHaveLength(31);
  });

  it("outlines the whole band, not any one cell, for a limiting input no cell carries, and captions it", () => {
    const cells = [cell("eth", { tierKey: "single-chain-or-native", home: true }), cell("sol", { tierKey: "single-chain-or-native" })];
    const banded = render(<DeploymentStrip ariaLabel="Deployments" cells={cells} bandLimiting="Bridge controls unverified" />).container;

    expect(banded.querySelectorAll("[data-band-outlined]")).toHaveLength(1);
    expect(cellKeysWith(banded, "data-outlined")).toEqual([]);
    expect(banded.querySelector('[data-legend-role="limiting"]')?.textContent).toContain("Bridge controls unverified");
    // Screen readers get it outside the aria-hidden drawing.
    const announced = Array.from(banded.querySelectorAll(".sr-only")).map((node) => node.textContent ?? "");
    expect(announced.some((text) => text.includes("Bridge controls unverified"))).toBe(true);

    const plain = render(<DeploymentStrip ariaLabel="Deployments" cells={cells} />).container;
    expect(plain.querySelector("[data-band-outlined]")).toBeNull();
    expect(plain.querySelector('[data-legend-role="limiting"]')).toBeNull();
  });

  it("draws a diagnostic in its tier's hue, dashed rather than faded, and keys it with the same treatment", () => {
    const { container } = render(
      <DeploymentStrip
        ariaLabel="Deployments"
        cells={[
          cell("home", { tierKey: "single-chain-or-native", tierLabel: "Native", home: true }),
          cell("oft", { tierKey: "external-lock-mint", tierLabel: "External lock & mint", role: "diagnostic" }),
        ]}
      />,
    );
    const treatment = BRIDGE_TIER_DIAGNOSTIC_CELL_CLASSES["external-lock-mint"].split(" ");
    const diagnosticCell = container.querySelector('[data-cell="oft"]')!;
    const swatch = container.querySelector('[data-legend-role="diagnostic"] > span')!;

    for (const token of treatment) {
      expect(diagnosticCell.classList.contains(token)).toBe(true);
      expect(swatch.classList.contains(token)).toBe(true);
    }
    expect(diagnosticCell.hasAttribute("data-hatched")).toBe(false);
    // The tier legend still keys the hue with the solid fill.
    const legend = Array.from(container.querySelectorAll("[data-legend-entry]")).map((entry) => entry.textContent ?? "");
    expect(legend).toEqual(["Native1", "External lock & mint1"]);
  });

  it("counts inventory totals in the legend when every drawn label has one, else the drawn cells", () => {
    const cells = [
      cell("a", { tierKey: "issuer-native-burn-mint", tierLabel: "Issuer burn & mint" }),
      cell("b", { tierKey: "external-lock-mint", tierLabel: "External lock & mint" }),
    ];
    const counts = (totals?: Record<string, number>) =>
      Array.from(
        render(<DeploymentStrip ariaLabel="Deployments" cells={cells} legendTotals={totals} />).container
          .querySelectorAll("[data-legend-count]"),
      ).map((node) => node.textContent);

    expect(counts({ "Issuer burn & mint": 40, "External lock & mint": 10 })).toEqual(["40", "10"]);
    expect(counts({ "Issuer burn & mint": 40 })).toEqual(["1", "1"]);
  });

  it("hatches unknown, opaque and unrecognised tiers and never a reviewed one", () => {
    const { container } = render(
      <DeploymentStrip
        ariaLabel="Deployments"
        cells={[
          cell("reviewed", { tierKey: "issuer-native-burn-mint" }),
          cell("unestablished", { tierKey: "issuer-native-burn-mint", unknown: true, tierLabel: "Not reviewed" }),
          cell("opaque", { tierKey: "opaque-or-unknown", tierLabel: "Opaque" }),
          cell("stray", { tierKey: "not-a-tier", tierLabel: "Unmapped" }),
        ]}
      />,
    );

    expect(cellKeysWith(container, "data-hatched")).toEqual(["unestablished", "opaque", "stray"]);
    // Every hatched cell shares one legend swatch, listed after the reviewed tier.
    const legend = Array.from(container.querySelectorAll("[data-legend-entry]")).map((entry) => entry.textContent ?? "");
    expect(legend).toHaveLength(2);
    expect(legend[0]).toContain("Tier of reviewed");
    expect(legend[1]).toEqual(expect.stringContaining("Not reviewed"));
    expect(legend[1]).toEqual(expect.stringContaining("Opaque"));
    expect(legend[1]).toEqual(expect.stringContaining("Unmapped"));
  });

  it("orders the legend by published tier quality, not by cell order", () => {
    const { container } = render(
      <DeploymentStrip
        ariaLabel="Deployments"
        cells={[
          cell("lock", { tierKey: "external-lock-mint", tierLabel: "Lock" }),
          cell("rollup", { tierKey: "canonical-rollup-bridge", tierLabel: "Rollup" }),
          cell("native", { tierKey: "single-chain-or-native", tierLabel: "Native" }),
        ]}
      />,
    );
    const legend = Array.from(container.querySelectorAll("[data-legend-entry]")).map((entry) => entry.textContent ?? "");
    expect(legend.map((entry) => entry.replace(/\d+$/, ""))).toEqual(["Native", "Rollup", "Lock"]);
  });

  it("marks an unquantified failure domain 'share unquantified' and a quantified one with its share", () => {
    const cells = [cell("eth", { home: true }), cell("plasma"), cell("solana"), cell("base")];
    const { container } = render(
      <DeploymentStrip
        ariaLabel="Deployments"
        cells={cells}
        brackets={[
          { key: "lz", label: "LayerZero V2 ×3", cellKeys: ["plasma", "base", "missing"] },
          { key: "plasma", label: "Plasma", cellKeys: ["plasma"], shareLabel: "10.8%" },
          { key: "ghost", label: "Ghost", cellKeys: ["missing"] },
        ]}
      />,
    );

    const lzShares = Array.from(container.querySelectorAll('[data-bracket="lz"] [data-bracket-share]'));
    // Two separated runs, one label.
    expect(container.querySelectorAll('[data-bracket="lz"]')).toHaveLength(2);
    expect(lzShares).toHaveLength(1);
    expect(lzShares[0]!.textContent).toBe("share unquantified");
    expect(container.querySelector('[data-bracket="lz"]')!.textContent).not.toMatch(/[%?]/);

    expect(container.querySelector('[data-bracket="plasma"] [data-bracket-share]')!.textContent).toBe("10.8%");
    // A domain spanning no drawn cell is not drawn.
    expect(container.querySelector('[data-bracket="ghost"]')).toBeNull();
  });

  it("names only the home chain once the strip is too dense for inline names", () => {
    const cells = Array.from({ length: 31 }, (_, index) => cell(`${index}`, { home: index === 0 }));
    const { container } = render(<DeploymentStrip ariaLabel="Deployments" cells={cells} />);
    const drawn = container.querySelector('[aria-hidden="true"]')!.textContent ?? "";

    expect(drawn).toContain("Chain 0");
    expect(drawn).not.toContain("Chain 7");
    expect(srItems(container)).toHaveLength(31);
  });

  it("renders nothing without cells", () => {
    const { container } = render(<DeploymentStrip ariaLabel="Deployments" cells={[]} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("bridge tier tones", () => {
  const quality = V9_CANDIDATE_POLICY_V1.policy.semantic.control.bridgeTierQuality;

  it("orders every published tier by non-increasing policy quality", () => {
    expect([...BRIDGE_TIER_POLICY_ORDER].sort()).toEqual([...BRIDGE_ROUTE_RISK_TIER_VALUES].sort());
    const scores = BRIDGE_TIER_POLICY_ORDER.map((tier) => quality[tier]);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("shares a fill exactly between tiers the policy scores alike", () => {
    const drawnTiers = BRIDGE_TIER_POLICY_ORDER.filter((tier) => tier !== "opaque-or-unknown");
    for (const a of drawnTiers) {
      for (const b of drawnTiers) {
        expect(BRIDGE_TIER_CELL_CLASSES[a] === BRIDGE_TIER_CELL_CLASSES[b]).toBe(quality[a] === quality[b]);
        expect(BRIDGE_TIER_DIAGNOSTIC_CELL_CLASSES[a] === BRIDGE_TIER_DIAGNOSTIC_CELL_CLASSES[b]).toBe(quality[a] === quality[b]);
      }
    }
  });

  it("never draws a diagnostic with a tier's solid fill", () => {
    for (const tier of BRIDGE_TIER_POLICY_ORDER) {
      expect(BRIDGE_TIER_DIAGNOSTIC_CELL_CLASSES[tier]).not.toBe(BRIDGE_TIER_CELL_CLASSES[tier]);
    }
  });
});
