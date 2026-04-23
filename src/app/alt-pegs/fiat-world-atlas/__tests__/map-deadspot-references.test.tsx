// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  DEADSPOT_ANCHORS,
  MapDeadspotReferences,
} from "@/app/alt-pegs/fiat-world-atlas/map-deadspot-references";

const items = [
  { peg: "GOLD",   label: "Gold",   href: "/stablecoins/gold",   coinCount: 8, symbolPreview: "XAUT · PAXG · KAU", group: "Commodity", region: "Other", colorHex: "#eab308" },
  { peg: "SILVER", label: "Silver", href: "/stablecoins/silver", coinCount: 1, symbolPreview: "KAG",              group: "Commodity", region: "Other", colorHex: "#9ca3af" },
  { peg: "VAR",    label: "CPI",    href: "/stablecoins/cpi",    coinCount: 3, symbolPreview: "FPI · ISC · SILK", group: "Other",     region: "Other", colorHex: "#64748b" },
] as never;

describe("MapDeadspotReferences", () => {
  it("renders Gold, Silver, and Index bodies at their deadspot anchors", () => {
    const { container } = render(<MapDeadspotReferences items={items} />);

    const bodies = container.querySelectorAll("li[data-body-kind]");
    expect(bodies.length).toBe(3);

    const sun = container.querySelector('li[data-body-kind="sun"]') as HTMLElement;
    const moon = container.querySelector('li[data-body-kind="moon"]') as HTMLElement;
    const index = container.querySelector('li[data-body-kind="index"]') as HTMLElement;

    expect(sun.style.left).toBe(`${DEADSPOT_ANCHORS.sun.x}%`);
    expect(sun.style.top).toBe(`${DEADSPOT_ANCHORS.sun.y}%`);
    expect(moon.style.left).toBe(`${DEADSPOT_ANCHORS.moon.x}%`);
    expect(moon.style.top).toBe(`${DEADSPOT_ANCHORS.moon.y}%`);
    expect(index.style.left).toBe(`${DEADSPOT_ANCHORS.index.x}%`);
    expect(index.style.top).toBe(`${DEADSPOT_ANCHORS.index.y}%`);
  });

  it("returns null when no non-geographic items provided", () => {
    const { container } = render(<MapDeadspotReferences items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("bodies link through to the cohort href", () => {
    const { container } = render(<MapDeadspotReferences items={items} />);

    const sunLink = container.querySelector('li[data-body-kind="sun"] a');
    const moonLink = container.querySelector('li[data-body-kind="moon"] a');
    const indexLink = container.querySelector('li[data-body-kind="index"] a');

    expect(sunLink?.getAttribute("href")).toBe("/stablecoins/gold");
    expect(moonLink?.getAttribute("href")).toBe("/stablecoins/silver");
    expect(indexLink?.getAttribute("href")).toBe("/stablecoins/cpi");
  });
});
