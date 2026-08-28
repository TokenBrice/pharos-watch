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

  it("stacks the field name above an all-caps mono value, with no jump icon", () => {
    const { getByRole } = render(<HeroPassportStrip items={ITEMS} />);

    const mechanism = getByRole("link", { name: "Peg mechanism: Custodial Cash — jump to Key Information" });
    const [label, value] = Array.from(mechanism.querySelectorAll("span"));
    expect(label.textContent).toBe("Mechanism");
    expect(label.className).toContain("uppercase");
    expect(label.className).toContain("tracking-wider");
    expect(value.textContent).toBe("Custodial Cash");
    expect(value.className).toContain("uppercase");
    expect(value.className).toContain("font-mono");
    expect(mechanism.querySelector("svg")).toBeNull();
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

  it("uses an explicit desktop grid template for compact hero rows", () => {
    const { container, getAllByRole } = render(<HeroPassportStrip items={ITEMS} compactDesktop />);

    const desktopGrid = container.querySelector(".hidden.lg\\:grid") as HTMLDivElement | null;
    expect(desktopGrid).not.toBeNull();
    expect(desktopGrid?.style.gridTemplateColumns).toBe("repeat(6, minmax(min-content, 1fr))");
    expect(desktopGrid?.className).not.toContain("grid-cols-[repeat");
    expect(getAllByRole("link")).toHaveLength(13);
  });

  it("tightens desktop cell padding once the strip carries nine or more fields", () => {
    const dense = [...ITEMS, ...ITEMS.slice(1, 5).map((item) => ({ ...item, key: `${item.key}-2` }))];
    const { container: sparse } = render(<HeroPassportStrip items={ITEMS} compactDesktop />);
    const sparseCell = sparse.querySelector(".hidden.lg\\:grid > a");
    expect(sparseCell?.className).toContain("px-4");

    const { container: crowded } = render(
      <HeroPassportStrip items={dense as typeof ITEMS} compactDesktop />,
    );
    const crowdedCell = crowded.querySelector(".hidden.lg\\:grid > a");
    expect(crowdedCell?.className).toContain("px-2.5");
  });
});
