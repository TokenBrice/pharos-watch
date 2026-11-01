// @vitest-environment jsdom

import { beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
import type { MechanismBackingView } from "@/lib/mechanism-backing";
import type { MechanismReviewView } from "@/lib/mechanism-review";
import type { StablecoinDetailCoinMeta } from "@/lib/stablecoin-detail-client-coin";
import { PegStabilityCard } from "../peg-stability-card";

// Without this mock `next/link` strips the canonical trailing slash: it only
// keeps it under next.config's `trailingSlash: true`, which vitest does not load.
// Vitest hoists the factory above static imports, so the helper loads dynamically.
vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

beforeAll(() => {
  // Radix Popper measures its anchor; jsdom ships no ResizeObserver.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});


/** A positive liquidation claim ("liquidates", "or liquidated"), not a statement that none exists. */
const LIQUIDATION_CLAIM = /\bliquidat(?:e|es|ed)\b/i;

const COLLATERAL = "Reserve collateral held by the protocol across several venues.";
const PEG_MECHANISM = "Users mint and redeem against the reserve under ratio limits.";
/** Past the 40-word prose budget, with a clean first sentence to keep visible. */
const LONG_PEG_MECHANISM =
  "Holders redeem directly with the issuer at par. Redemptions settle through the issuer's banking partners on business days, subject to onboarding, minimum sizes, fees and the issuer's published terms, while secondary-market liquidity across centralized and decentralized venues carries the peg for holders who cannot redeem directly.";

function coin(overrides: Partial<StablecoinDetailCoinMeta> = {}): StablecoinDetailCoinMeta {
  return {
    id: "fixture-coin",
    name: "Fixture Dollar",
    symbol: "FXD",
    flags: { backing: "crypto-backed", governance: "decentralized" },
    collateral: COLLATERAL,
    pegMechanism: PEG_MECHANISM,
    mechanismArchetype: "cdp",
    ...overrides,
  } as StablecoinDetailCoinMeta;
}

const NO_LIQUIDATION_REVIEW: Pick<MechanismBackingView, "notes"> = {
  notes: [
    {
      key: "component:liquidationMechanics",
      label: "Liquidation mechanics",
      state: "not-applicable",
      rationale: "Djed-style reserve with no borrower positions.",
      sourceUrl: null,
    },
  ],
};

const COIN_PRICE_FEED = { role: "coin-price-feed" } as StablecoinDetailCoinMeta["oracleRiskSummary"];

function mechanismModule(container: HTMLElement): HTMLElement {
  const card = container.querySelector<HTMLElement>("#mechanism");
  if (!card) throw new Error("Mechanism module did not render");
  return card;
}

describe("PegStabilityCard", () => {
  it("draws a Djed-style cdp reserve without the CDP liquidation path", () => {
    const { container } = render(
      <PegStabilityCard
        meta={coin({ oracleRiskSummary: COIN_PRICE_FEED })}
        isWrapper={false}
        mechanismBacking={NO_LIQUIDATION_REVIEW}
      />,
    );
    const figure = within(mechanismModule(container)).getByRole("figure");
    expect(figure.textContent).not.toMatch(LIQUIDATION_CLAIM);
  });

  it("keeps the CDP liquidation path when no review rules it out", () => {
    const { container } = render(<PegStabilityCard meta={coin()} isWrapper={false} />);
    const figure = within(mechanismModule(container)).getByRole("figure");
    expect(figure.textContent).toMatch(LIQUIDATION_CLAIM);
  });

  it("merges the mechanism review into the one provenance fold, which owns #mechanism-review", () => {
    const review: MechanismReviewView = {
      archetype: "cdp",
      reviewedAt: "2026-07-15",
      notes: "Vaults liquidate below the minimum ratio.\nThe stability pool absorbs bad debt.",
      sources: [
        { label: "Protocol docs", url: "https://example.com/docs" },
        { label: "Audit report", url: "https://example.com/audit" },
      ],
    };
    const { container } = render(
      <PegStabilityCard
        meta={coin({ pegMechanism: LONG_PEG_MECHANISM })}
        isWrapper={false}
        mechanismReview={review}
      />,
    );
    const card = mechanismModule(container);
    const folds = card.querySelectorAll("details");
    expect(folds).toHaveLength(1);
    const fold = folds[0]!;
    expect(fold.id).toBe("mechanism-review");
    expect(fold.open).toBe(false);
    expect(within(fold).getByText(/stability pool absorbs bad debt/).textContent).toBe(review.notes);
    expect(fold.textContent).toContain(LONG_PEG_MECHANISM);
    for (const source of review.sources) {
      const link = within(fold).getByRole("link", { name: source.label });
      expect(link.getAttribute("href")).toBe(source.url);
      expect(link.getAttribute("target")).toBe("_blank");
    }
    // Two notes (peg mechanism, review) and two sources.
    expect(fold.querySelector("summary")?.textContent).toContain("(4)");
    // The review date stamps the footer once, outside the fold.
    expect(card.textContent!.split(review.reviewedAt)).toHaveLength(2);
    expect(fold.textContent).not.toContain(review.reviewedAt);
    expect(card.textContent).toContain(`Reviewed ${review.reviewedAt}`);
  });

  it("leaves #mechanism-review and the review stamp out without a mechanism review", () => {
    const { container } = render(
      <PegStabilityCard meta={coin({ pegMechanism: LONG_PEG_MECHANISM })} isWrapper={false} />,
    );
    const card = mechanismModule(container);
    expect(card.querySelector("#mechanism-review")).toBeNull();
    expect(card.textContent).not.toContain("Reviewed ");
  });

  it("describes an rwa-credit-fund coin as a fund portfolio, never a credit portfolio", () => {
    const { container } = render(
      <PegStabilityCard meta={coin({ mechanismArchetype: "rwa-credit-fund" })} isWrapper={false} />,
    );
    const text = within(mechanismModule(container)).getByRole("figure").textContent ?? "";
    expect(text).toContain("Fund portfolio");
    expect(text).toContain("value tracks fund NAV");
    // Tokenized fund shares and bullion trackers use this archetype too.
    expect(text).not.toMatch(/private credit|credit portfolio|credit losses|CLO/i);
  });

  it("never names another coin's incident in a coin's stress line", () => {
    const usdt = render(
      <PegStabilityCard
        meta={coin({ id: "usdt-tether", symbol: "USDT", mechanismArchetype: "fiat-cash" })}
        isWrapper={false}
      />,
    );
    expect(within(mechanismModule(usdt.container)).getByRole("figure").textContent).not.toMatch(/\bUSDC\b/);
    cleanup();

    // A coin's own dated incident comes from its override and stays.
    const usdc = render(
      <PegStabilityCard
        meta={coin({ id: "usdc-circle", symbol: "USDC", mechanismArchetype: "fiat-cash" })}
        isWrapper={false}
      />,
    );
    expect(within(mechanismModule(usdc.container)).getByRole("figure").textContent).toMatch(/\b2023\b/);
  });
});
