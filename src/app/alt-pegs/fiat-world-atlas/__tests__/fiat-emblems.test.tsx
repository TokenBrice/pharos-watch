// @vitest-environment jsdom
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FiatEmblems } from "@/app/alt-pegs/fiat-world-atlas/fiat-emblems";
import type { PegCluster } from "@/lib/alt-peg-hero";
import { makePlacedCoin as coin, renderAtlas } from "./atlas.test-support";

describe("FiatEmblems", () => {

  it("adds center hit targets for crowded map hover while keeping them out of tab order", () => {
    const clusters: PegCluster[] = [
      {
        peg: "EUR",
        rank: 1,
        anchor: { x: 52, y: 20 },
        colorHex: "#60a5fa",
        coins: [
          coin({ id: "eurc-circle", symbol: "EURC", sizePx: 84, marketCap: 400_000_000, x: 52, y: 20 }),
          coin({ id: "vchf-vnx", symbol: "VCHF", sizePx: 30, marketCap: 4_000_000, x: 51, y: 22, pegCurrency: "CHF" }),
        ],
      },
    ];

    const { container } = renderAtlas(<><FiatEmblems clusters={clusters} /></>);

    const hitTarget = container.querySelector('[data-hit-coin-id="vchf-vnx"]') as HTMLAnchorElement;
    expect(hitTarget).not.toBeNull();
    expect(hitTarget.getAttribute("aria-hidden")).toBe("true");
    expect(hitTarget.getAttribute("tabindex")).toBe("-1");
    expect(container.querySelector(".coin-emblem__mini-label")).toBeNull();

    fireEvent.mouseEnter(hitTarget);
    expect(screen.getByRole("tooltip").textContent).toContain("VCHF");
  });
});
