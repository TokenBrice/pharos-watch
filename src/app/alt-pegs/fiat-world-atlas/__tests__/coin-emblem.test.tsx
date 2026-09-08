// @vitest-environment jsdom
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CoinEmblem } from "@/app/alt-pegs/fiat-world-atlas/coin-emblem";
import { makePlacedCoin, renderAtlas } from "./atlas.test-support";

const sample = makePlacedCoin({
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
});

describe("CoinEmblem", () => {

  it("renders an anchor with href and accessible label", () => {
    const { getByRole } = renderAtlas(<><CoinEmblem coin={sample} variant="fiat" /></>);
    const link = getByRole("link");
    expect(link.getAttribute("href")).toBe("/stablecoin/eurc-circle");
    expect(link.getAttribute("aria-label")).toContain("EURC");
    expect(link.getAttribute("aria-label")).toContain("EUR");
  });

  it("shows a key-data hover card for the active stablecoin", () => {
    const { getByRole } = renderAtlas(<><CoinEmblem
      coin={sample}
      variant="fiat"
      cohortCoinCount={4}
      cohortMarketCap={1_000_000_000}
      cohortSymbolPreview="EURC · EURCV · AEUR"
      cohortRank={2}
      showTickerLabel
    /></>);
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
    fireEvent.mouseLeave(link);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(link.hasAttribute("aria-describedby")).toBe(false);
  });

  it("shows the hover card on keyboard focus", () => {
    const { getByRole } = renderAtlas(<><CoinEmblem coin={sample} variant="fiat" cohortCoinCount={4} cohortMarketCap={1_000_000_000} /></>);
    const link = getByRole("link");
    fireEvent.focus(link);

    expect(screen.getByRole("tooltip").textContent).toContain("Open EURC profile");
    fireEvent.blur(link);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(link.hasAttribute("aria-describedby")).toBe(false);
  });

  it("keeps requested ticker labels visible for small single-coin cohorts", () => {
    renderAtlas(<><CoinEmblem coin={{ ...sample, sizePx: 34 }} variant="fiat" showTickerLabel /></>);

    expect(screen.getByText("EURC", { selector: ".coin-emblem__mini-label" })).toBeTruthy();
  });

  it("moves the tooltip and accessible description to the newly hovered coin", () => {
    renderAtlas(<><CoinEmblem coin={sample} variant="fiat" />
    <CoinEmblem coin={{ ...sample, id: "peer", symbol: "PEER" }} variant="fiat" /></>);
    const [first, second] = screen.getAllByRole("link");
    fireEvent.mouseEnter(first);
    expect(first.getAttribute("aria-describedby")).toBe(screen.getByRole("tooltip").id);
    fireEvent.mouseEnter(second);
    expect(screen.getByRole("tooltip").textContent).toContain("Open PEER profile");
    expect(first.hasAttribute("aria-describedby")).toBe(false);
    expect(second.getAttribute("aria-describedby")).toBe(screen.getByRole("tooltip").id);
  });

  it.each([
    { marketCap: 432_000_000, cohortMarketCap: undefined },
    { marketCap: 432_000_000, cohortMarketCap: 0 },
    { marketCap: 0, cohortMarketCap: 1_000_000_000 },
  ])("does not manufacture a share from unavailable evidence: %j", ({ marketCap, cohortMarketCap }) => {
    renderAtlas(<><CoinEmblem coin={{ ...sample, marketCap }} variant="fiat" cohortMarketCap={cohortMarketCap} /></>);
    const link = screen.getByRole("link");
    fireEvent.mouseEnter(link);
    expect(screen.getByText("Cohort share").nextElementSibling?.textContent).toBe("n/a");
    expect(link.getAttribute("aria-label")).not.toContain("%");
    if (marketCap === 0) expect(screen.getByText("Market cap").nextElementSibling?.textContent).toBe("n/a");
    if (!cohortMarketCap) expect(screen.getByText("Cohort cap").nextElementSibling?.textContent).toBe("n/a");
  });

});
