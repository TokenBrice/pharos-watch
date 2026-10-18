// @vitest-environment jsdom

import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeroPassportItemViewModel } from "@/lib/stablecoin-detail-passport";
import { buildHeroPassportItems } from "@/lib/stablecoin-detail-passport";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { RedemptionBackstopEntry } from "@shared/types";

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
      coin: TRACKED_META_BY_ID.get("usdc-circle")!, chainCount: 1, blacklistStatus: null,
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
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "#mechanism",
      "#attestation",
      "#jurisdiction",
      "#redemption",
      "#mint-authority",
      "#blacklist",
      "#contracts",
    ]);
  });

  it("reserves supplemental passport tracks without inventing facts or section links", () => {
    const initial = ITEMS.filter((item) => item.key !== "redeemability" && item.key !== "minting");
    const { container, rerender } = render(<HeroPassportStrip items={initial} compactDesktop />);
    expect(container.querySelectorAll('[data-passport-reserve="redeemability"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-passport-reserve="minting"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-passport-reserve="record"]')).toHaveLength(2);
    expect(container.querySelector('a[href="#redemption"]')).toBeNull();
    expect(container.querySelector('a[href="#mint-authority"]')).toBeNull();
    const chains = container.querySelector('a[href="#contracts"]')!;
    expect(chains.className).toContain("w-40");
    rerender(<HeroPassportStrip items={ITEMS} compactDesktop />);
    expect(container.querySelectorAll('[data-passport-reserve="redeemability"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-passport-reserve="minting"]')).toHaveLength(0);
    expect(container.querySelector('a[href="#contracts"]')).toBe(chains);
    expect(chains.className).toContain("w-40");
  });

  it("renders nothing when fewer than three facts resolve", () => {
    const { container } = render(<HeroPassportStrip items={ITEMS.slice(0, 2)} />);
    expect(container.firstChild).toBeNull();
  });

});
