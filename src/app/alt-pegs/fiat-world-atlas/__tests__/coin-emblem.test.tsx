// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CoinEmblem } from "@/app/alt-pegs/fiat-world-atlas/coin-emblem";
import { HoverProvider } from "@/app/alt-pegs/fiat-world-atlas/hover-context";
import type { PlacedCoin } from "@/lib/alt-peg-hero";

const sample: PlacedCoin = {
  id: "eurc-circle",
  symbol: "EURC",
  name: "EURC",
  href: "/stablecoin/eurc-circle",
  logoSrc: "/logos/50-eurc.png",
  pegCurrency: "EUR",
  marketCap: 432_000_000,
  x: 52,
  y: 20,
  sizePx: 109,
};

describe("CoinEmblem", () => {
  afterEach(() => cleanup());

  it("renders an anchor with href and accessible label", () => {
    const { getByRole } = render(
      <HoverProvider>
        <CoinEmblem coin={sample} variant="fiat" />
      </HoverProvider>,
    );
    const link = getByRole("link");
    expect(link.getAttribute("href")).toBe("/stablecoin/eurc-circle");
    expect(link.getAttribute("aria-label")).toContain("EURC");
    expect(link.getAttribute("aria-label")).toContain("EUR");
  });

  it("sizes + positions via inline style", () => {
    const { getByRole } = render(
      <HoverProvider>
        <CoinEmblem coin={sample} variant="fiat" />
      </HoverProvider>,
    );
    const link = getByRole("link") as HTMLAnchorElement;
    expect(link.style.width).toBe("109px");
    expect(link.style.height).toBe("109px");
    expect(link.style.left).toBe("52%");
    expect(link.style.top).toBe("20%");
  });

  it("applies variant-specific class", () => {
    const { getByRole, rerender } = render(
      <HoverProvider>
        <CoinEmblem coin={sample} variant="sun-core" />
      </HoverProvider>,
    );
    expect(getByRole("link").className).toContain("coin-emblem--sun-core");

    rerender(
      <HoverProvider>
        <CoinEmblem coin={{ ...sample, pegCurrency: "VAR" }} variant="star" />
      </HoverProvider>,
    );
    expect(getByRole("link").className).toContain("coin-emblem--star");
  });

  it("encodes data-coin-id and data-peg for hover wiring", () => {
    const { getByRole } = render(
      <HoverProvider>
        <CoinEmblem coin={sample} variant="fiat" />
      </HoverProvider>,
    );
    const link = getByRole("link");
    expect(link.getAttribute("data-coin-id")).toBe("eurc-circle");
    expect(link.getAttribute("data-peg")).toBe("EUR");
  });
});
