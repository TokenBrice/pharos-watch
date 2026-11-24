// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeStablecoinMeta } from "@shared/test-utils/stablecoin";
import { HeroChipRail } from "../hero-card-sections";

vi.mock("@/lib/feature-flags", () => ({ isHeroVerdictEnabled: () => true }));
vi.mock("next/link", async () => {
  // Vitest hoists this mock factory; load the helper inside that isolated module boundary.
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

describe("detail verdict lane", () => {
  it("renders the verdict lane only when a verdict is shown, leaving the taxonomy unchanged", () => {
    const coin = makeStablecoinMeta({ id: "usdt-tether", name: "Tether", symbol: "USDT" });
    const { container, rerender } = render(<HeroChipRail coin={coin} verdict={{ archetype: "uncategorized", label: "Uncategorized" }} />);
    expect(container.querySelector("[data-hero-verdict-lane]")).toBeNull();
    const initialTaxonomy = container.firstElementChild!.firstElementChild!.innerHTML;
    rerender(<HeroChipRail coin={coin} verdict={{ archetype: "yield-bearing-hybrid", label: "Yield-Bearing Hybrid" }} />);
    const lane = container.querySelector("[data-hero-verdict-lane]")!;
    expect(lane.textContent).toContain("Yield-Bearing Hybrid");
    // The verdict leads the taxonomy chip row instead of taking a line of its own.
    expect(lane.parentElement!.firstElementChild).toBe(lane);
    lane.remove();
    expect(container.firstElementChild!.firstElementChild!.innerHTML).toBe(initialTaxonomy);
  });

  it("ends the chip row with the launch date, so it sits inline wherever the row has room", () => {
    const coin = makeStablecoinMeta({ id: "zchf-frankencoin", name: "Frankencoin", symbol: "ZCHF", launchDate: "2023-10-28" });
    const { getByText } = render(<HeroChipRail coin={coin} verdict={{ archetype: "uncategorized", label: "Uncategorized" }} />);
    const date = getByText("Oct 28, 2023");
    expect(date.parentElement!.lastElementChild).toBe(date);
    expect(date.parentElement!.querySelectorAll("a").length).toBeGreaterThan(0);
  });

  it("tones the verdict by archetype and lets a coin state lead", () => {
    const coin = makeStablecoinMeta({ id: "mai-qidao", name: "MAI", symbol: "MAI" });
    const { container, rerender } = render(<HeroChipRail coin={coin} verdict={{ archetype: "distressed", label: "Distressed" }} />);
    const lane = () => container.querySelector("[data-hero-verdict-lane]")!;
    expect(lane().className).toContain("text-state-danger");
    expect(lane().innerHTML).not.toContain("badge-check");
    rerender(<HeroChipRail coin={coin} verdict={{ archetype: "decentralized-benchmark", label: "Decentralized Benchmark" }} />);
    expect(lane().innerHTML).toContain("badge-check");
    const paused = { kind: "paused", notice: { type: "warning", title: "Mint and redemption paused" } } as const;
    rerender(<HeroChipRail coin={coin} verdict={{ archetype: "distressed", label: "Distressed" }} state={paused} />);
    expect(lane().id).toBe("hero-verdict-mai-qidao");
    expect(lane().querySelector("[data-coin-state='paused']")?.textContent).toContain("Paused");
    expect(lane().textContent).not.toContain("Distressed");
  });

  it("renders no lane and no chip for the internal institutional-default archetype", () => {
    const coin = makeStablecoinMeta({ id: "usdc-circle", name: "USD Coin", symbol: "USDC" });
    const { container } = render(<HeroChipRail coin={coin} verdict={{ archetype: "institutional-default", label: "Institutional Default" }} />);
    expect(container.querySelector("[data-hero-verdict-lane]")).toBeNull();
    expect(container.querySelector(`#hero-verdict-${coin.id}`)).toBeNull();
    expect(container.textContent).not.toContain("Institutional");
    expect(container.querySelector("[data-tokenized-fund-badge]")).toBeNull();
    expect(container.querySelector("[data-tokenized-fund-notice]")).toBeNull();
  });

  it("shows the tokenized fund badge and notice on active tokenized fund detail pages", () => {
    const fund = makeStablecoinMeta({ id: "buidl-blackrock", name: "BlackRock USD Institutional Digital Liquidity Fund", symbol: "BUIDL" });
    const { container } = render(<HeroChipRail coin={fund} verdict={{ archetype: "uncategorized", label: "Uncategorized" }} />);
    const badge = container.querySelector("[data-tokenized-fund-badge]");
    const notice = container.querySelector("[data-tokenized-fund-notice]");
    expect(badge?.textContent).toContain("Tokenized fund — not a stablecoin");
    expect(badge?.getAttribute("title")).toContain("backs stablecoins Pharos follows");
    expect(notice?.textContent).toContain("Not counted in stablecoin totals and not Safety-graded");
  });
});
