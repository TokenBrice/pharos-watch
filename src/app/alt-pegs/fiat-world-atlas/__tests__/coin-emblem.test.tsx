// @vitest-environment jsdom
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CoinEmblem } from "@/app/alt-pegs/fiat-world-atlas/coin-emblem";
import { summarizeCohort } from "@/app/alt-pegs/fiat-world-atlas/cohort-coin-emblems";
import { FiatEmblems } from "@/app/alt-pegs/fiat-world-atlas/fiat-emblems";
import { buildPegDiversityHero } from "@/lib/alt-peg-hero";
import { coreNonUsdRows } from "@shared/test-utils/alt-peg-fixtures";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
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
    { marketCap: null, cohortMarketCap: 1_000_000_000 },
  ])("does not manufacture a share from unavailable evidence: %j", ({ marketCap, cohortMarketCap }) => {
    renderAtlas(<><CoinEmblem coin={{ ...sample, marketCap }} variant="fiat" cohortMarketCap={cohortMarketCap} /></>);
    const link = screen.getByRole("link");
    fireEvent.mouseEnter(link);
    expect(screen.getByText("Cohort share").nextElementSibling?.textContent).toBe("n/a");
    expect(link.getAttribute("aria-label")).not.toContain("%");
    if (marketCap === null) expect(screen.getByText("Market cap").nextElementSibling?.textContent).toBe("Unavailable");
    if (cohortMarketCap === undefined) expect(screen.getByText("Cohort cap").nextElementSibling?.textContent).toBe("Unavailable");
    if (cohortMarketCap === 0) expect(screen.getByText("Cohort cap").nextElementSibling?.textContent).toContain("$0");
  });

  it("preserves measured zero market cap and cohort share", () => {
    renderAtlas(<CoinEmblem coin={{ ...sample, marketCap: 0 }} variant="fiat" cohortMarketCap={100} />);
    fireEvent.focus(screen.getByRole("link"));
    expect(screen.getByText("Market cap").nextElementSibling?.textContent).toContain("$0");
    expect(screen.getByText("Cohort share").nextElementSibling?.textContent).toContain("0");
    expect(screen.getByRole("link").getAttribute("aria-label")).toContain("%");
  });

  it("discloses known cohort subtotals and withholds partial-denominator shares", () => {
    const eur = buildPegDiversityHero([makeStablecoin({ id: sample.id, circulating: { usd: sample.marketCap! } })])
      .pegClusters.find((group) => group.peg === "EUR")!;
    const summary = summarizeCohort([sample], eur.cohort);
    const unavailableCount = eur.cohort.coinCount - 1;
    expect(summary).toMatchObject({ marketCap: sample.marketCap, coinCount: eur.cohort.coinCount, supplyUnavailableCount: unavailableCount });
    const unknown = buildPegDiversityHero([makeStablecoin({ id: sample.id, circulating: {} })])
      .pegClusters.find((group) => group.peg === "EUR")!;
    expect(summarizeCohort([{ ...sample, marketCap: null }], unknown.cohort).marketCap).toBeNull();
    renderAtlas(<FiatEmblems clusters={[{ ...eur, coins: [sample] }]} />);
    fireEvent.focus(screen.getByRole("link"));
    expect(screen.getByText("Cohort share").nextElementSibling?.textContent).toBe("n/a");
    expect(screen.getByText("Known cohort subtotal").nextElementSibling?.textContent).toContain(`${unavailableCount} unavailable`);
    expect(screen.getByText("Cohort size").nextElementSibling?.textContent).toBe(`${eur.cohort.coinCount} coins`);
    expect(screen.getByRole("link").getAttribute("aria-label")).not.toMatch(/%|#\d/);
  });

  it("withholds the cohort share and the complete cap over a partial-chain remainder", () => {
    // Every other core non-USD member observes a supply, so the only incomplete
    // observation in the euro cohort is EURC's recorded partial-chain remainder.
    const assets = coreNonUsdRows(
      (id, marketCap) => makeStablecoin({
        id,
        circulating: marketCap === null ? {} : { usd: marketCap },
        ...(id === sample.id ? {
          supplyChainGuard: {
            reason: "supply-chain-dropout" as const,
            status: "chains-unavailable" as const,
            partialCoverage: true as const,
            quarantinedSince: 1_792_800_000,
            chains: [{
              chainId: "tempo", chainLabel: "Tempo", listCurrentUsd: 0, baselineUsd: 1_653_927,
              baselineObservedAt: 1_792_700_000, baselineSource: "seed" as const, resolution: "unavailable" as const,
            }],
          },
        } : {}),
      }),
      { [sample.id]: sample.marketCap!, "eurs-stasis": 40_000_000 },
    );
    const eur = buildPegDiversityHero(assets).pegClusters.find((group) => group.peg === "EUR")!;
    const cohortCap = sample.marketCap! + 40_000_000;
    expect(eur.cohort).toMatchObject({ marketCap: cohortCap, supplyUnavailableCount: 0, supplyPartialCount: 1 });

    renderAtlas(<FiatEmblems clusters={[eur]} />);
    const link = screen.getByRole("link", { name: /^EURC · / });
    fireEvent.focus(link);
    expect(screen.getByText("Cohort share").nextElementSibling?.textContent).toBe("n/a");
    expect(screen.getByText("Known cohort subtotal").nextElementSibling?.textContent)
      .toContain("1 partial-chain remainder");
    expect(screen.queryByText("Cohort cap")).toBeNull();
    expect(link.getAttribute("aria-label")).not.toContain("%");
    expect(summarizeCohort(eur.coins, eur.cohort)).toMatchObject({ marketCap: cohortCap, supplyPartialCount: 1 });
  });

});
