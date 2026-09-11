import { createElement, type ReactNode } from "react";
import { render } from "@testing-library/react";
import { HoverProvider } from "@/app/alt-pegs/fiat-world-atlas/hover-context";
import type { PlacedCoin } from "@/lib/alt-peg-hero";

export function makePlacedCoin(overrides: Partial<PlacedCoin> & Pick<PlacedCoin, "id">): PlacedCoin {
  return {
    symbol: overrides.id.toUpperCase(),
    name: overrides.id,
    href: `/stablecoin/${overrides.id}`,
    logoSrc: "/logos/50-eurc.png",
    pegCurrency: "EUR",
    marketCap: 10_000_000,
    x: 50,
    y: 20,
    sizePx: 36,
    ...overrides,
  };
}

export function renderAtlas(children: ReactNode) {
  return render(createElement(HoverProvider, null, children));
}
