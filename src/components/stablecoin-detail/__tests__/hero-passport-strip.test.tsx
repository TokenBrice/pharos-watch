// @vitest-environment jsdom

import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeroPassportItemViewModel } from "@/lib/stablecoin-detail-passport";
import { buildHeroPassportItems } from "@/lib/stablecoin-detail-passport";
import { makeStablecoinMeta } from "@shared/test-utils/stablecoin";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

import { HeroPassportStrip } from "../hero-passport-strip";

const ITEMS: HeroPassportItemViewModel[] = [
  {
    key: "mechanism",
    category: "Mechanism",
    value: "Custodial Cash",
    href: "#mechanism",
    ariaLabel: "Peg mechanism: Custodial Cash — jump to Key Information",
  },
  {
    key: "attestor",
    category: "Attestor",
    value: "Big-4 attestor",
    href: "#attestation",
    valueClass: "text-emerald-700 dark:text-emerald-400",
    ariaLabel: "Reserve attestation: Big-4 attestor — jump to Proof of Reserves",
  },
  {
    key: "jurisdiction",
    category: "Jurisdiction",
    value: "United States",
    href: "#jurisdiction",
    ariaLabel: "Jurisdiction: United States — jump to jurisdiction details",
  },
  {
    key: "redeemability",
    category: "Redeemability",
    value: "Issuer / institutional",
    href: "#redemption",
    ariaLabel: "Redeemability: Issuer / institutional — jump to Redemption Backstop",
  },
  {
    key: "minting",
    category: "Minting",
    value: "Issuer direct mint",
    href: "#mint-authority",
    ariaLabel: "Minting: Issuer direct mint — jump to Mint Authority",
  },
  {
    key: "freeze",
    category: "Freeze",
    value: "Yes",
    href: "#blacklist",
    valueClass: "text-amber-700 dark:text-amber-400",
    ariaLabel: "Freezable — issuer can freeze, block, or seize balances",
  },
  {
    key: "chains",
    category: "Chains",
    value: "151",
    href: "#contracts",
    ariaLabel: "Deployed on 151 chains — jump to contract deployments",
  },
];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("HeroPassportStrip", () => {
  it.each(["wheel", "touchstart", "pointerdown", "keydown"])(
    "stops passport alignment when the reader takes over with %s",
    (eventName) => {
      vi.useFakeTimers();
      const scroll = vi.fn();
      const { getByRole } = render(
        <><HeroPassportStrip items={ITEMS} /><section id="mechanism" ref={(node) => { if (node) node.scrollIntoView = scroll; }} /></>,
      );
      const link = getByRole("link", { name: ITEMS[0].ariaLabel });
      // The activating pointer event precedes click and must not cancel the new batch.
      fireEvent.pointerDown(link);
      fireEvent.click(link);
      expect(scroll).toHaveBeenCalledWith({ block: "start" });
      act(() => { vi.advanceTimersByTime(160); });
      expect(scroll.mock.calls.length).toBeGreaterThan(1);
      fireEvent(window, new Event(eventName));
      const callsAfterTakeover = scroll.mock.calls.length;
      act(() => { vi.advanceTimersByTime(7000); });
      expect(scroll).toHaveBeenCalledTimes(callsAfterTakeover);
    },
  );

  it("cancels the previous alignment batch on replacement jump and unmount", () => {
    vi.useFakeTimers();
    const firstScroll = vi.fn();
    const secondScroll = vi.fn();
    const { getByRole, unmount } = render(
      <>
        <HeroPassportStrip items={ITEMS} />
        <section id="mechanism" ref={(node) => { if (node) node.scrollIntoView = firstScroll; }} />
        <section id="attestation" ref={(node) => { if (node) node.scrollIntoView = secondScroll; }} />
      </>,
    );
    fireEvent.click(getByRole("link", { name: ITEMS[0].ariaLabel }));
    fireEvent.click(getByRole("link", { name: ITEMS[1].ariaLabel }));
    act(() => { vi.advanceTimersByTime(2000); });
    expect(firstScroll).toHaveBeenCalledTimes(1);
    expect(secondScroll.mock.calls.length).toBeGreaterThan(1);
    unmount();
    const callsBeforeUnmount = secondScroll.mock.calls.length;
    act(() => { vi.advanceTimersByTime(7000); });
    expect(secondScroll).toHaveBeenCalledTimes(callsBeforeUnmount);
  });

  it("does not realign after the hash changes", () => {
    vi.useFakeTimers();
    const scroll = vi.fn();
    const { getByRole } = render(
      <><HeroPassportStrip items={ITEMS} /><section id="mechanism" ref={(node) => { if (node) node.scrollIntoView = scroll; }} /></>,
    );
    fireEvent.click(getByRole("link", { name: ITEMS[0].ariaLabel }));
    window.history.pushState(null, "", "#elsewhere");
    act(() => { vi.advanceTimersByTime(7000); });
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["permissionless-onchain", "Permissionless", "Permissionless onchain"],
    ["whitelisted-onchain", "Whitelisted", "Whitelisted onchain"],
    ["issuer-api", "Institutional", "Issuer / institutional"],
    ["manual", "Manual", "Manual / discretionary"],
  ] as const)("keeps compact %s access visible and its full name accessible", (accessModel, shortLabel, fullLabel) => {
    const redemptionBackstop: RedemptionBackstopEntry = {
      stablecoinId: "usdc-circle", score: 65, dexLiquidityScore: null,
      accessScore: 40, settlementScore: 65, executionCertaintyScore: 60,
      capacityScore: 100, outputAssetQualityScore: 100, costScore: 40,
      routeFamily: "offchain-issuer", accessModel, settlementModel: "same-day",
      executionModel: "rules-based-nav", outputAssetType: "stable-single",
      provider: "supply-full-model", sourceMode: "estimated", resolutionState: "resolved",
      routeStatus: "open", routeStatusSource: "static-config", holderEligibility: "verified-customer",
      capacityConfidence: "heuristic", capacitySemantics: "eventual-only",
      feeConfidence: "undisclosed-reviewed", feeModelKind: "undisclosed-reviewed", modelConfidence: "low",
      immediateCapacityUsd: null, immediateCapacityRatio: null, feeBps: null, queueEnabled: false,
      methodologyVersion: "1.1", updatedAt: 1_700_000_000, capsApplied: [],
    };
    const items = buildHeroPassportItems({
      coin: makeStablecoinMeta({ id: "usdc-circle", name: "USD Coin", symbol: "USDC" }), chainCount: 1, blacklistStatus: null,
      resolvedMechanismArchetype: null,
      mintAuthority: { status: "not-reviewed", mintPathLabel: "Unknown", mintPathShortLabel: "Unknown" },
      redemptionBackstop, pegScoreResult: { eventCount: 0 }, isNavToken: false,
    });
    const { getByRole } = render(<HeroPassportStrip items={items} />);
    const route = getByRole("link", { name: `Redeemability: ${fullLabel} — jump to redemption route` });
    expect(route.textContent).toContain(shortLabel);
    expect(route.getAttribute("href")).toBe("#redemption");
  });

  it("renders one document-style anchor entry per passport item", () => {
    const { getByRole, getAllByRole } = render(<HeroPassportStrip items={ITEMS} />);

    expect(getByRole("group", { name: "Verification passport" })).toBeTruthy();
    const links = getAllByRole("link");
    expect(links).toHaveLength(7);
    // How the token works, then who stands behind it, whatever the input order.
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "#mechanism",
      "#redemption",
      "#mint-authority",
      "#blacklist",
      "#contracts",
      "#jurisdiction",
      "#attestation",
    ]);
  });

  it("holds a pending fact's slot in both layouts without inventing a fact or a section link", () => {
    const initial = ITEMS.filter((item) => item.key !== "redeemability");
    const { container, rerender } = render(<HeroPassportStrip items={initial} pendingKeys={["redeemability"]} compactDesktop />);
    // One reserve in the scrolling mobile row, one blank cell in the desktop
    // grid; a fact that is not pending (no record for a NAV token) has no slot.
    expect(container.querySelectorAll('[data-passport-reserve="redeemability"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-passport-reserve="record"]')).toHaveLength(0);
    expect(container.querySelector('a[href="#redemption"]')).toBeNull();
    const desktopCells = () => container.querySelectorAll(".\\@container > div > *");
    expect(desktopCells()).toHaveLength(6);
    const chains = container.querySelector('a[href="#contracts"]')!;
    expect(chains.className).toContain("w-40");
    rerender(<HeroPassportStrip items={ITEMS} compactDesktop />);
    expect(container.querySelectorAll("[data-passport-reserve]")).toHaveLength(0);
    // The landed fact takes the reserved slot: the desktop grid keeps its cell count.
    expect(desktopCells()).toHaveLength(6);
    expect(container.querySelector('a[href="#contracts"]')).toBe(chains);
  });

  it("balances the desktop rows instead of leaving an orphan cell", () => {
    const facts = (["redeemability", "minting", "freeze", "record", "chains", "jurisdiction", "mica", "genius"] as const)
      .map((key) => ({ ...ITEMS[0], key, ariaLabel: key, href: `#${key}` }));
    const { container, rerender } = render(<HeroPassportStrip items={[ITEMS[0], ...facts]} compactDesktop />);
    const cellClass = () => container.querySelector('.\\@container a[href="#minting"]')!.className;
    // Eight facts: one row when each gets 8.5rem, else two rows of four.
    expect(cellClass()).toContain("basis-1/4 @[68rem]:basis-0");
    rerender(<HeroPassportStrip items={[ITEMS[0], ...facts.slice(0, 7)]} compactDesktop />);
    expect(cellClass()).toContain("basis-1/4 @[59.5rem]:basis-0");
    rerender(<HeroPassportStrip items={[ITEMS[0], ...facts.slice(0, 5)]} compactDesktop />);
    expect(cellClass()).toContain("basis-0");
    expect(cellClass()).not.toContain("basis-1/");
  });

  it("does not publish a zero-chain fact when no contract record exists", () => {
    const items = buildHeroPassportItems({
      coin: makeStablecoinMeta({ id: "hbd-hive", name: "Hive Dollar", symbol: "HBD" }),
      chainCount: 0,
      blacklistStatus: null,
      resolvedMechanismArchetype: null,
      mintAuthority: { status: "not-reviewed", mintPathLabel: "Unknown", mintPathShortLabel: "Unknown" },
      redemptionBackstop: null,
      pegScoreResult: null,
      isNavToken: false,
    });
    const { queryByRole, queryByText } = render(<HeroPassportStrip items={items} />);

    expect(queryByRole("link", { name: /Deployed on 0 chains/ })).toBeNull();
    expect(queryByText("Chains")).toBeNull();
  });

  it("keeps the card's rounded corner and prints the chain count like every other fact", () => {
    const { getByRole } = render(<HeroPassportStrip items={ITEMS} compactDesktop />);
    const strip = getByRole("group", { name: "Verification passport" });
    // Docked last in the card, the strip clips to its bottom corners; the
    // scroll fade belongs to the scrolling mobile row only.
    expect(strip.className).toContain("overflow-hidden");
    expect(strip.className).toContain("last:rounded-b-xl");
    const fade = strip.querySelector(".pointer-events-none")!;
    expect(fade.className).toContain("lg:hidden");
    expect(fade.className).not.toContain("xl:block");
    for (const chains of strip.querySelectorAll('a[href="#contracts"]')) {
      expect(chains.querySelector(".rounded-full")).toBeNull();
    }
  });

  it("renders nothing when fewer than three facts resolve", () => {
    const { container } = render(<HeroPassportStrip items={ITEMS.slice(0, 2)} />);
    expect(container.firstChild).toBeNull();
  });

});
