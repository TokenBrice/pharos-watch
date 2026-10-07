// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { getMechanismExplainerPath } from "@shared/lib/classification";
import type { MechanismBackingView } from "@/lib/mechanism-backing";
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

afterEach(cleanup);

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

  it("folds the curated collateral paragraph only when Reserves has reviewed slices", () => {
    const open = render(<PegStabilityCard meta={coin()} isWrapper={false} />);
    const visible = within(mechanismModule(open.container)).getByText(COLLATERAL);
    expect(visible.closest("details")).toBeNull();
    cleanup();

    const folded = render(<PegStabilityCard meta={coin()} isWrapper={false} hasReviewedReserves />);
    const card = mechanismModule(folded.container);
    const disclosure = within(card).getByText(COLLATERAL).closest("details");
    expect(disclosure).not.toBeNull();
    expect(disclosure?.open).toBe(false);
    // The peg-mechanism primer stays in the summary layer.
    expect(within(card).getByText(PEG_MECHANISM).closest("details")).toBeNull();
  });

  it("draws a wrapper's parent flow as text steps, not a scaled-down SVG", () => {
    const { container } = render(
      <PegStabilityCard
        meta={coin({ id: "fixture-wrapper", symbol: "sFXD", mechanismArchetype: "synthetic-delta-neutral" })}
        resolvedMechanismArchetype="synthetic-delta-neutral"
        isWrapper
        parentSymbol="FXD"
        parentArchetype="synthetic-delta-neutral"
        variantKind="savings-passthrough"
      />,
    );
    const figure = within(mechanismModule(container)).getByRole("figure");
    const [parentSteps, wrapperLayer] = within(figure).getAllByRole("list");
    expect(within(parentSteps).getAllByRole("listitem")).toHaveLength(3);
    expect(within(wrapperLayer).getByRole("listitem").textContent).toContain("sFXD");
    // Every glyph is DOM text at body size; no SVG label shrinks with its viewBox.
    expect(figure.querySelectorAll("svg text")).toHaveLength(0);
  });

  it("renders nothing without a peg mechanism", () => {
    const { container } = render(<PegStabilityCard meta={coin({ pegMechanism: undefined })} isWrapper={false} />);
    expect(container.querySelector("#mechanism")).toBeNull();
  });

  it("closes authored prose that lacks its final stop, without touching the data", () => {
    const meta = coin({ pegMechanism: "Direct redemption through the issuer (verified customers)" });
    const { container } = render(<PegStabilityCard meta={meta} isWrapper={false} />);
    const card = mechanismModule(container);
    expect(within(card).getByText("Direct redemption through the issuer (verified customers).")).toBeTruthy();
    expect(meta.pegMechanism).toBe("Direct redemption through the issuer (verified customers)");
  });

  it("folds over-budget prose and the collateral note into one Review notes disclosure", () => {
    const { container } = render(
      <PegStabilityCard meta={coin({ pegMechanism: LONG_PEG_MECHANISM })} isWrapper={false} hasReviewedReserves />,
    );
    const card = mechanismModule(container);
    const folds = card.querySelectorAll("details");
    expect(folds).toHaveLength(1);
    const fold = folds[0]!;
    expect(fold.open).toBe(false);
    expect(fold.textContent).toContain(LONG_PEG_MECHANISM);
    expect(fold.textContent).toContain(COLLATERAL);
    // Both folded items are counted in the summary's accessible name.
    expect(fold.querySelector("summary")?.textContent).toContain("(2)");
    // The first clean sentence stays in the summary layer.
    const line = within(card).getByText("Holders redeem directly with the issuer at par.");
    expect(line.closest("details")).toBeNull();
  });

  it("puts the help glyph beside the title and opens the archetype primer from it", () => {
    const { container } = render(<PegStabilityCard meta={coin()} isWrapper={false} />);
    const card = mechanismModule(container);
    const heading = within(card).getByRole("heading", { name: /Mechanism/ });
    const hint = within(card).getByRole("button", { name: /mechanism/i });
    const figure = within(card).getByRole("figure");
    // In the header, right after the title: after the heading, before the visual.
    expect(heading.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(hint.compareDocumentPosition(figure) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(hint);
    const explainer = screen.getByRole("link", { name: /explainer/i });
    expect(explainer.getAttribute("href")).toBe(getMechanismExplainerPath("cdp"));
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
