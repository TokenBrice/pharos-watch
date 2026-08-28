// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
    expect(link.style.width).toBe("calc(var(--coin-size) * var(--peg-coin-scale, 1))");
    expect(link.style.height).toBe("calc(var(--coin-size) * var(--peg-coin-scale, 1))");
    expect(link.style.getPropertyValue("--coin-size")).toBe("109px");
    expect(link.style.left).toBe("52%");
    expect(link.style.top).toBe("20%");
    expect(link.style.getPropertyValue("--coin-z")).toBe("24");
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

  it("shows a key-data hover card for the active stablecoin", () => {
    const { getByRole } = render(
      <HoverProvider>
        <CoinEmblem
          coin={sample}
          variant="fiat"
          cohortCoinCount={4}
          cohortMarketCap={1_000_000_000}
          cohortSymbolPreview="EURC · EURCV · AEUR"
          cohortRank={2}
          showTickerLabel
        />
      </HoverProvider>,
    );
    const link = getByRole("link");
    fireEvent.mouseEnter(link);

    const card = screen.getByRole("tooltip");
    expect(card.textContent).toContain("EURC");
    expect(card.textContent).toContain("Euro cohort");
    expect(card.textContent).toContain("Market cap");
    expect(card.textContent).toContain("Cohort share");
    expect(card.textContent).toContain("43.2%");
    expect(card.textContent).toContain("Cohort cap");
    expect(card.textContent).toContain("Cohort size");
    expect(card.textContent).toContain("4 coins");
    expect(card.textContent).toContain("Top peers");
    expect(card.textContent).toContain("EURC · EURCV · AEUR");
    expect(card.textContent).toContain("#2 by non-USD cap");
    expect(card.textContent).toContain("Open EURC profile");
    expect(screen.getByText("EURC", { selector: ".coin-emblem__mini-label" })).toBeTruthy();
    expect(link.getAttribute("aria-label")).toContain("#2 by non-USD cap");
    expect(link.getAttribute("aria-describedby")).toBe(card.id);
  });

  it("shows the hover card on keyboard focus", () => {
    const { getByRole } = render(
      <HoverProvider>
        <CoinEmblem coin={sample} variant="fiat" cohortCoinCount={4} cohortMarketCap={1_000_000_000} />
      </HoverProvider>,
    );
    const link = getByRole("link");
    fireEvent.focus(link);

    expect(screen.getByRole("tooltip").textContent).toContain("Open EURC profile");
  });

  it("keeps requested ticker labels visible for small single-coin cohorts", () => {
    render(
      <HoverProvider>
        <CoinEmblem coin={{ ...sample, sizePx: 34 }} variant="fiat" showTickerLabel />
      </HoverProvider>,
    );

    expect(screen.getByText("EURC", { selector: ".coin-emblem__mini-label" })).toBeTruthy();
  });

  it("positions edge hover cards back toward the map frame", () => {
    const { getByRole } = render(
      <HoverProvider>
        <CoinEmblem coin={{ ...sample, x: 88, y: 12 }} variant="fiat" />
      </HoverProvider>,
    );
    const link = getByRole("link");
    expect(link.getAttribute("data-card-x")).toBe("right");
    expect(link.getAttribute("data-card-y")).toBe("below");
  });

  it("allows sky cohorts to force hover cards below the emblem", () => {
    const { getByRole } = render(
      <HoverProvider>
        <CoinEmblem coin={{ ...sample, y: 70 }} variant="moon" hoverCardYPlacement="below" />
      </HoverProvider>,
    );
    expect(getByRole("link").getAttribute("data-card-y")).toBe("below");
  });
});
