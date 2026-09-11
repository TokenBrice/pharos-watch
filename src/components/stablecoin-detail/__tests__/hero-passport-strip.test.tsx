// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { HeroPassportItemViewModel } from "@/lib/stablecoin-detail-passport";

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

describe("HeroPassportStrip", () => {

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

  it("pairs each field name with its own value", () => {
    const { getByRole } = render(<HeroPassportStrip items={ITEMS} />);

    const mechanism = getByRole("link", { name: "Peg mechanism: Custodial Cash — jump to Key Information" });
    const [label, value] = Array.from(mechanism.querySelectorAll("span"));
    expect(label.textContent).toBe("Mechanism");
    expect(value.textContent).toBe("Custodial Cash");
  });

  it("applies data-driven text tones to tinted values only", () => {
    const { getByRole } = render(<HeroPassportStrip items={ITEMS} />);

    const freeze = getByRole("link", { name: "Freezable — issuer can freeze, block, or seize balances" });
    expect(freeze.querySelectorAll("span")[1].className).toContain("text-amber-700");
    const mechanism = getByRole("link", { name: "Peg mechanism: Custodial Cash — jump to Key Information" });
    expect(mechanism.querySelectorAll("span")[1].className).toContain("text-foreground");
  });

  it("renders nothing when fewer than three facts resolve", () => {
    const { container } = render(<HeroPassportStrip items={ITEMS.slice(0, 2)} />);
    expect(container.firstChild).toBeNull();
  });

  it("drops the mechanism cell from the compact desktop tier while the mobile row keeps it", () => {
    // Mechanism already has its own hero treatment, so the compact desktop
    // strip spends that column on a fact the card does not otherwise show.
    const { container } = render(<HeroPassportStrip items={ITEMS} compactDesktop />);

    const tiers = Array.from(container.querySelectorAll("div")).filter((node) => node.querySelector(":scope > a"));
    expect(tiers).toHaveLength(2);
    const [mobileHrefs, desktopHrefs] = tiers.map((tier) =>
      Array.from(tier.querySelectorAll(":scope > a")).map((link) => link.getAttribute("href")),
    );

    expect(mobileHrefs).toEqual(ITEMS.map((item) => item.href));
    expect(desktopHrefs).toEqual(
      ITEMS.filter((item) => item.category !== "Mechanism").map((item) => item.href),
    );
  });
});
