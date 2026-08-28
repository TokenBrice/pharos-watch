// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FiatEmblems } from "@/app/alt-pegs/fiat-world-atlas/fiat-emblems";
import { HoverProvider } from "@/app/alt-pegs/fiat-world-atlas/hover-context";
import type { PegCluster, PlacedCoin } from "@/lib/alt-peg-hero";

function coin(overrides: Partial<PlacedCoin> & Pick<PlacedCoin, "id" | "symbol">): PlacedCoin {
  return {
    id: overrides.id,
    symbol: overrides.symbol,
    name: overrides.symbol,
    href: `/stablecoin/${overrides.id}`,
    logoSrc: "/logos/50-eurc.png",
    pegCurrency: overrides.pegCurrency ?? "EUR",
    marketCap: overrides.marketCap ?? 10_000_000,
    x: overrides.x ?? 50,
    y: overrides.y ?? 20,
    sizePx: overrides.sizePx ?? 36,
  };
}

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

    const { container } = render(
      <HoverProvider>
        <FiatEmblems clusters={clusters} />
      </HoverProvider>,
    );

    const hitTarget = container.querySelector('[data-hit-coin-id="vchf-vnx"]') as HTMLAnchorElement;
    expect(hitTarget).not.toBeNull();
    expect(hitTarget.getAttribute("aria-hidden")).toBe("true");
    expect(hitTarget.getAttribute("tabindex")).toBe("-1");
    expect(hitTarget.style.width).toBe("calc(var(--hit-size) * var(--peg-hit-scale, 1))");
    expect(hitTarget.style.height).toBe("calc(var(--hit-size) * var(--peg-hit-scale, 1))");
    expect(hitTarget.style.getPropertyValue("--hit-size")).toBe("24px");
    expect(container.querySelector(".coin-emblem__mini-label")).toBeNull();

    fireEvent.mouseEnter(hitTarget);
    expect(screen.getByRole("tooltip").textContent).toContain("VCHF");
  });
});
