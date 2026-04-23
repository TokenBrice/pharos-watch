// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CelestialBand } from "@/app/alt-pegs/fiat-world-atlas/celestial-band";

const items = [
  { peg: "GOLD",   label: "Gold",   href: "/stablecoins/gold",   coinCount: 8, symbolPreview: "XAUT · PAXG · KAU", group: "Commodity", region: "Other", colorHex: "#eab308" },
  { peg: "SILVER", label: "Silver", href: "/stablecoins/silver", coinCount: 1, symbolPreview: "KAG",              group: "Commodity", region: "Other", colorHex: "#9ca3af" },
  { peg: "VAR",    label: "CPI",    href: "/stablecoins/cpi",    coinCount: 3, symbolPreview: "FPI · ISC · SILK", group: "Other",     region: "Other", colorHex: "#64748b" },
] as never;

afterEach(cleanup);

describe("CelestialBand", () => {
  it("renders Gold, Silver, and Index orbitals with the right hrefs and counts", () => {
    const { container, getByRole } = render(<CelestialBand items={items} />);

    expect(getByRole("link", { name: /Gold, 8 coins/ })).toBeTruthy();
    expect(getByRole("link", { name: /Silver, 1 coins/ })).toBeTruthy();
    expect(getByRole("link", { name: /CPI, 3 coins/ })).toBeTruthy();

    const sun = container.querySelector('[data-orbital="sun"]');
    const moon = container.querySelector('[data-orbital="moon"]');
    const index = container.querySelector('[data-orbital="index"]');
    expect(sun?.getAttribute("data-coin-count")).toBe("8");
    expect(moon?.getAttribute("data-coin-count")).toBe("1");
    expect(index?.getAttribute("data-coin-count")).toBe("3");
  });

  it("returns null when there are no non-geographic references", () => {
    const { container } = render(<CelestialBand items={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
