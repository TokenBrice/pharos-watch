// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
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

  it("qualifies a partly known share with what is left out, visually and for screen readers", () => {
    const { container } = render(
      <DeploymentStrip
        ariaLabel="Deployments"
        cells={[cell("eth", { home: true }), cell("plasma"), cell("solana")]}
        brackets={[{ key: "lz", label: "LayerZero V2 ×3", cellKeys: ["plasma", "solana"], shareLabel: "≥21%", shareNote: "1 unquantified" }]}
      />,
    );

    const caption = container.querySelector('[data-bracket="lz"] [data-bracket-share]')!.textContent;
    expect(caption).toContain("≥21%");
    expect(caption).toContain("1 unquantified");
    const announced = container.querySelector('ul[aria-label="Shared failure domains"] > li')!.textContent;
    expect(announced).toContain("≥21%");
    expect(announced).toContain("1 unquantified");
  });

});
