// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { findSummaryBudgetViolations } from "@shared/lib/summary-budget";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { ReserveResult } from "@shared/lib/reserve-templates";
import type { ReserveQualityClientSummary } from "@/lib/stablecoin-detail-reserve-quality-client";
import type { ReserveLookThroughClientSummary } from "@/lib/stablecoin-detail-reserve-look-through-client";
import { ReservesSection, type ReservesSectionProps } from "../reserves-section";
import { projectReserveQualityClientSummary } from "@/lib/stablecoin-detail-reserve-quality-client";
import { projectReserveLookThroughClientSummary } from "@/lib/stablecoin-detail-reserve-look-through-client";

// Without this mock `next/link` strips the canonical trailing slash: it only
// keeps it under next.config's `trailingSlash: true`, which vitest does not load.
// Vitest hoists the factory above static imports, so the helper loads dynamically.
vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

const COIN = TRACKED_META_BY_ID.get("iusd-infinifi")!;
const AMBER_VALUE_CLASS = "text-amber-600";
// A coin whose curated `reserves` is empty: nothing reviewed to draw.
const NO_REVIEW_COIN = { ...COIN, reserves: [] };

const SUMMARY: ReserveQualityClientSummary = {
  chipLabel: "Highly liquid",
  chipToneClass: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700",
  lede: "2 reviewed reserve slices — 100% convertible within one day.",
  ladder: [
    { key: "immediate", label: "Immediate", pct: 20 },
    { key: "over-seven-days", label: "> 7 days", pct: 12.9 },
    { key: "one-day", label: "≤ 1 day", pct: 67.1 },
  ],
  liquidWithinOneDayPct: 87.1,
  unknownHorizonPct: 0,
  unidentifiedObligorsPct: 0,
  selfExposurePct: null,
  topPositionName: null,
  topPositionPct: null,
  asOf: "2026-06-30",
  sliceCount: 2,
  confidenceLabel: "Verified",
  reviewedAt: "2026-07-18",
  compositionBasis: "Monthly attestation composition table.",
  knownUnknownExposureNote: "No undisclosed obligors in the attested basket.",
  slices: [
    {
      key: "bank:1", name: "Bank deposits", pct: 20, assetClassLabel: "Bank deposits", horizonLabel: "Immediate",
      riskLabel: "Very low", risk: "very-low", obligor: "Regulated banks", riskFactorLabels: [],
    },
    {
      key: "bills:0", name: "U.S. Treasury bills", pct: 80, assetClassLabel: "Treasury bills", horizonLabel: "≤ 1 day",
      riskLabel: "Very low", risk: "very-low", obligor: "U.S. Treasury", riskFactorLabels: ["duration", "liquidity"],
    },
  ],
  sources: [{ label: "Circle reserve report", url: "https://example.com/reserves" }],
};

function makeReserves(overrides: Partial<ReserveResult> = {}): ReserveResult {
  return {
    reserves: [{ name: "Live farm", pct: 100, risk: "low" }],
    estimated: false,
    mode: "live",
    liveAt: 1_700_000_000,
    source: "fixture",
    ...overrides,
  };
}

const STALE_USDC = makeReserves({
  mode: "live-stale",
  source: "circle-transparency",
  displayBadge: { kind: "proof", label: "Attestation" },
  provenance: { evidenceClass: "independent", sourceModel: "dynamic-mix", scoringEligible: false },
  metadata: { sourceTimestamp: Date.parse("2026-09-24T00:00:00Z") / 1000 },
  sync: {
    enabled: true,
    status: "error",
    stale: true,
    bootstrap: false,
    failureCategory: "validation",
    lastError: "Validation failed: Redemption source timestamp is 1066290s old for dynamic-mix/independent (max 604800s)",
    warnings: ["Redemption source timestamp is 1066290s old for dynamic-mix/independent (max 604800s)"],
  },
  reserves: [
    { name: "<3-Month U.S. Treasuries", pct: 49.9, risk: "very-low" },
    { name: "Deposits at Systemically Important Institutions", pct: 35.5, risk: "very-low" },
    { name: "Other Bank Deposits", pct: 12.6, risk: "very-low" },
    { name: "Overnight Reverse Treasury Repo", pct: 2, risk: "very-low" },
  ],
});

function renderSection(props: Partial<ReservesSectionProps> = {}) {
  return render(
    <ReservesSection coin={COIN} reserves={null} reserveFetchError={null} qualitySummary={SUMMARY} {...props} />,
  );
}

function factValue(label: string): HTMLElement {
  const value = screen.getByText(label).nextElementSibling;
  if (!(value instanceof HTMLElement)) throw new Error(`No value for fact ${label}`);
  return value;
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ReservesSection", () => {
  it.each(["alusd-alchemix", "stusd-stoneyield"])(
    "keeps selected historical slices contextual rather than whole-basket quality or look-through (%s)",
    (id) => {
      const coin = TRACKED_META_BY_ID.get(id)!;
      const qualitySummary = projectReserveQualityClientSummary(coin);
      const lookThrough = projectReserveLookThroughClientSummary(coin, TRACKED_META_BY_ID);
      expect(lookThrough).toBeNull();
      const { container } = renderSection({ coin, qualitySummary, lookThrough });
      expect(screen.queryByText("Highly liquid")).toBeNull();
      expect(screen.queryByText("Liquid ≤ 1 day")).toBeNull();
      expect(screen.queryByLabelText("Liquidity horizon ladder")).toBeNull();
      expect(container.textContent).not.toContain("100% convertible within one day");
      expect(screen.getByRole("figure").getAttribute("aria-label")).toContain("Contextual reserve slices");
      expect(container.textContent).toContain(coin.reserves![0]!.name);
      expect(container.textContent).toContain(coin.reserveReview!.compositionBasis);
    },
  );
  it("renders nothing without reserves, a fetch error or a reviewed summary, and a skeleton while loading", () => {
    const { container, rerender } = renderSection({ coin: NO_REVIEW_COIN, qualitySummary: null });
    expect(container.innerHTML).toBe("");
    rerender(<ReservesSection coin={NO_REVIEW_COIN} reserves={null} reserveFetchError={null} isLoading />);
    expect(container.querySelector('section#reserves[aria-busy="true"]')).not.toBeNull();
  });

  it("builds the module from the reviewed slices: one visual, at most four facts, both anchors", () => {
    const { container } = renderSection();
    const region = screen.getByRole("region", { name: "Reserves" });
    expect(region.id).toBe("reserves");
    // The hero/FAQ alias lives inside the module, ahead of its visual.
    const alias = region.querySelector("#reserve-quality");
    expect(alias).not.toBeNull();
    expect(alias!.compareDocumentPosition(screen.getByRole("figure")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelectorAll("#reserve-quality")).toHaveLength(1);
    expect(screen.getByText("Reserves")).toBeDefined();
    expect(screen.getByText("Highly liquid")).toBeDefined();
    expect(screen.getByText(SUMMARY.lede)).toBeDefined();
    expect(container.querySelectorAll('[role="figure"]')).toHaveLength(1);
    expect(screen.getByRole("figure").getAttribute("aria-label"))
      .toBe("Reviewed reserve slices: U.S. Treasury bills 80%, Bank deposits 20%");

    const facts = within(screen.getByRole("group", { name: "Reserve facts" }));
    expect(facts.getByText("Liquid ≤ 1 day")).toBeDefined();
    expect(facts.getByText("Unresolved reserve exposure")).toBeDefined();
    expect(facts.getByText("Top position")).toBeDefined();
    expect(facts.getByText("As of")).toBeDefined();
    expect(facts.queryByText("Slices")).toBeNull();
    expect(container.querySelectorAll('[role="group"][aria-label="Reserve facts"] > *')).toHaveLength(4);
  });

  it("drops the raw obligor list and the mix bar", () => {
    const { container } = renderSection();
    expect(container.querySelector('[aria-label="Recorded reserve obligors"]')).toBeNull();
    expect(container.textContent).not.toContain("Obligor names or classes recorded");
    expect(container.textContent).not.toContain("Asset mix");
  });

  it("folds the ladder in neutral and blue, never red, and lists slice detail by share", () => {
    renderSection();
    const ladder = screen.getByLabelText("Liquidity horizon ladder");
    expect(within(ladder).getByText("> 7 days")).toBeDefined();
    expect(ladder.innerHTML).not.toMatch(/bg-red|bg-amber|bg-emerald/);
    const names = Array.from(screen.getByLabelText("Reserve slices").querySelectorAll("li p span"));
    expect(names.map((node) => node.textContent)).toEqual(["U.S. Treasury bills", "Bank deposits"]);
  });

  it("adds the reviewed date to the footer and names the source in the as-of fact", () => {
    const { container } = renderSection();
    expect(container.textContent).toContain("Reviewed 2026-07-18");
    expect(factValue("As of").textContent).toContain("2026-06-30");
    expect(factValue("As of").textContent).toContain("Circle reserve report");
    expect(container.innerHTML).toContain("https://example.com/reserves");
  });

  it("keeps one status chip in the header and moves confidence and source type to the chip row", () => {
    const precedesVisual = (node: Node) =>
      Boolean(node.compareDocumentPosition(screen.getByRole("figure")) & Node.DOCUMENT_POSITION_FOLLOWING);
    const { container, unmount } = renderSection({
      reserves: makeReserves({ displayBadge: { kind: "proof", label: "Attestation" }, provenance: STALE_USDC.provenance }),
    });
    const headerChips = Array.from(container.querySelectorAll('[data-slot="badge"]')).filter(precedesVisual);
    expect(headerChips).toHaveLength(1);
    expect(headerChips[0]!.textContent).toBe(SUMMARY.chipLabel);
    expect(precedesVisual(screen.getByRole("button", { name: "Attestation" }))).toBe(false);
    expect(precedesVisual(screen.getByText((text) => text.includes(SUMMARY.confidenceLabel!)))).toBe(false);
    unmount();

    // An unhealthy feed adds its ops chip beside the status chip, never a second status chip.
    renderSection({ reserves: STALE_USDC });
    expect(precedesVisual(screen.getByText(SUMMARY.chipLabel))).toBe(true);
    expect(precedesVisual(screen.getByRole("button", { name: /Reserve feed stale/ }))).toBe(true);
    expect(precedesVisual(screen.getByRole("button", { name: "Attestation" }))).toBe(false);
  });

  it("folds review notes and sources together, last, under one footer line", () => {
    const { container } = renderSection({ reserves: STALE_USDC });
    const folds = Array.from(container.querySelectorAll("details"));
    const provenance = folds.filter((fold) => fold.querySelector(`a[href="${SUMMARY.sources[0]!.url}"]`));
    expect(provenance).toHaveLength(1);
    expect(folds[folds.length - 1]).toBe(provenance[0]);
    expect(provenance[0]!.open).toBe(false);
    expect(provenance[0]!.textContent).toContain(SUMMARY.compositionBasis!);
    expect(provenance[0]!.textContent).toContain(SUMMARY.knownUnknownExposureNote!);
    // Reviewer narrative leaves the slice detail; the merged fold is the only place it appears.
    const sliceFold = screen.getByLabelText("Reserve slices").closest("details") as HTMLElement;
    expect(sliceFold.textContent).not.toContain(SUMMARY.compositionBasis!);
    expect(container.textContent?.split(SUMMARY.compositionBasis!).length).toBe(2);
    // The count in the fold's name covers notes and sources.
    expect(provenance[0]!.querySelector("summary")?.textContent).toMatch(/\b3\b/);
    // The disclosure ids the page deep-links to survive.
    expect(container.querySelector("details#reserve-feed-status")).not.toBeNull();
  });

  it("bounds the verdict: an over-budget lede falls back to its first sentence", () => {
    const lede = "12 reviewed reserve slices — at least 30% convertible within one day; 10% has no published exit timeline. "
      + "12.6% of the basket has unresolved reserve exposure. 5% is issuer self-exposure rather than independent collateral.";
    expect(findSummaryBudgetViolations(lede)).not.toHaveLength(0);
    renderSection({ qualitySummary: { ...SUMMARY, lede } });
    const verdict = screen.getByText(/^12 reviewed reserve slices/);
    expect(findSummaryBudgetViolations(verdict.textContent ?? "")).toHaveLength(0);
    expect(lede.startsWith(verdict.textContent ?? "")).toBe(true);
  });

  describe("liquid ≤ 1 day fact", () => {
    it("stays neutral when the basket clears the watch line", () => {
      renderSection();
      expect(factValue("Liquid ≤ 1 day").className).not.toContain(AMBER_VALUE_CLASS);
      expect(factValue("Liquid ≤ 1 day").textContent).toBe("87.1%");
    });

    it("turns amber only when the disclosed shortfall cannot be cured by the undisclosed share", () => {
      const { unmount } = renderSection({ qualitySummary: { ...SUMMARY, liquidWithinOneDayPct: 30, unknownHorizonPct: 10 } });
      expect(factValue("Liquid ≤ 1 day").className).toContain(AMBER_VALUE_CLASS);
      expect(factValue("Liquid ≤ 1 day").textContent).toBe("≥ 30%");
      unmount();

      renderSection({ qualitySummary: { ...SUMMARY, liquidWithinOneDayPct: 9.9, unknownHorizonPct: 90.1 } });
      expect(factValue("Liquid ≤ 1 day").className).not.toContain(AMBER_VALUE_CLASS);
    });

    it("says the exit timeline is not published rather than printing 0%", () => {
      renderSection({ qualitySummary: { ...SUMMARY, liquidWithinOneDayPct: 0, unknownHorizonPct: 100 } });
      expect(factValue("Liquid ≤ 1 day").textContent).toBe("Not published");
    });
  });

  it("amber-flags unresolved reserve exposure and a concentration finding only when present", () => {
    const { unmount } = renderSection();
    expect(factValue("Unresolved reserve exposure").className).not.toContain(AMBER_VALUE_CLASS);
    expect(factValue("Top position").className).not.toContain(AMBER_VALUE_CLASS);
    unmount();

    renderSection({
      qualitySummary: { ...SUMMARY, unidentifiedObligorsPct: 12.6, topPositionName: "Hedged basis book", topPositionPct: 62.4 },
    });
    expect(factValue("Unresolved reserve exposure").textContent).toBe("12.6%");
    expect(factValue("Unresolved reserve exposure").className).toContain(AMBER_VALUE_CLASS);
    expect(factValue("Top position").className).toContain(AMBER_VALUE_CLASS);
  });

  it("draws a single slice with no joinable parent as one composition bar and omits the redundant top-position fact", () => {
    const { container } = renderSection({
      qualitySummary: {
        ...SUMMARY,
        sliceCount: 1,
        slices: [{ ...SUMMARY.slices[0]!, name: "ETH", pct: 100, obligor: "Ethereum" }],
      },
    });
    const figure = screen.getByRole("figure");
    expect(figure.getAttribute("aria-label")).toContain("ETH 100%");
    // The bar names the slice's asset class; no treemap stage is mounted.
    expect(figure.getAttribute("aria-label")).toContain(SUMMARY.slices[0]!.assetClassLabel!);
    expect(container.querySelector("[class*='pharos-chart-stage']")).toBeNull();
    expect(screen.queryByText("Top position")).toBeNull();
  });

  describe("wrapper look-through", () => {
    const WRAPPER_SUMMARY: ReserveQualityClientSummary = {
      ...SUMMARY,
      sliceCount: 1,
      slices: [{
        key: "vault:0", name: "PAR staking vault shares", pct: 100, assetClassLabel: "Protocol position",
        horizonLabel: "≤ 1 day", riskLabel: "Medium", risk: "medium", obligor: "Vault and PAR", riskFactorLabels: [],
      }],
    };
    const LOOK_THROUGH: ReserveLookThroughClientSummary = {
      parentId: "par-coin",
      parentSymbol: "PAR",
      parentReviewedAt: "2026-09-30",
      slices: [
        { key: "cash:0", name: "Liquid cash strategy basket", pct: 70, risk: "medium", obligor: null, assetClassLabel: "Cash" },
        { key: "btc:1", name: "BTC collateral", pct: 30, risk: "high", obligor: null, assetClassLabel: null },
      ],
    };

    it("draws the parent's reviewed slices labelled via the parent, with the wrapper slice named", () => {
      const { container } = renderSection({ qualitySummary: WRAPPER_SUMMARY, lookThrough: LOOK_THROUGH });
      expect(container.querySelectorAll('[role="figure"]')).toHaveLength(1);
      const label = screen.getByRole("figure").getAttribute("aria-label") ?? "";
      expect(label).toContain("Liquid cash strategy basket 70%");
      expect(label).toContain("BTC collateral 30%");
      expect(label).toContain("PAR staking vault shares");
      const via = screen.getByRole("link", { name: "PAR" });
      expect(via.getAttribute("href")).toBe("/stablecoin/par-coin/#reserves");
      expect(via.closest("p")?.textContent).toMatch(/PAR staking vault shares.*via PAR/);
    });

    it("words the verdict over the drawn parent slices, not the wrapper's single claim", () => {
      renderSection({ qualitySummary: WRAPPER_SUMMARY, lookThrough: LOOK_THROUGH });
      expect(screen.queryByText(SUMMARY.lede)).toBeNull();
      const verdict = screen.getByText(/^Via PAR: 2 reviewed slices/);
      expect(verdict.textContent).toContain("Liquid cash strategy basket");
      expect(verdict.textContent).toContain("70%");
    });

    it("keeps the review stamp as the one visible date and folds the parent and basis dates", () => {
      const { container } = renderSection({
        qualitySummary: WRAPPER_SUMMARY,
        lookThrough: LOOK_THROUGH,
        reserves: makeReserves({ metadata: { sourceTimestamp: Date.parse("2026-09-24T00:00:00Z") / 1000 } }),
      });
      expect(screen.queryByText("As of")).toBeNull();
      const folds = [...container.querySelectorAll("details")];
      const foldText = folds.map((fold) => fold.textContent ?? "").join(" ");
      let visibleText = container.textContent ?? "";
      for (const fold of folds) visibleText = visibleText.replace(fold.textContent ?? "", "");
      expect(visibleText).toContain("Reviewed 2026-07-18");
      expect(visibleText).not.toContain("2026-09-30");
      expect(visibleText).not.toContain(SUMMARY.asOf!);
      expect(visibleText).not.toContain("2026-09-24");
      expect(foldText).toContain("PAR reserves reviewed 2026-09-30");
      expect(foldText).toContain(`basis as of ${SUMMARY.asOf}`);
      expect(foldText).toContain("2026-09-24");
    });

    it("keeps the wrapper's own basket when its reviewed basis is not a single slice", () => {
      renderSection({ lookThrough: LOOK_THROUGH });
      expect(screen.getByRole("figure").getAttribute("aria-label"))
        .toBe("Reviewed reserve slices: U.S. Treasury bills 80%, Bank deposits 20%");
      expect(screen.queryByRole("link", { name: "PAR" })).toBeNull();
    });

    it("falls back to the composition bar when the look-through carries no drawable slice", () => {
      renderSection({
        qualitySummary: WRAPPER_SUMMARY,
        lookThrough: { ...LOOK_THROUGH, slices: [{ ...LOOK_THROUGH.slices[0]!, pct: 0 }] },
      });
      expect(screen.getByRole("figure").getAttribute("aria-label")).toContain("PAR staking vault shares 100%");
      expect(screen.queryByRole("link", { name: "PAR" })).toBeNull();
    });
  });

  describe("reserve feed", () => {
    it("turns a stale validation error into one amber header chip with the detail in a disclosure", () => {
      const { container } = renderSection({ reserves: STALE_USDC });
      const chip = screen.getByRole("button", { name: "Reserve feed stale · last report 24 Sep · 7-day budget" });
      expect(chip.innerHTML).toContain("amber");
      expect(container.textContent).not.toMatch(/Validation failed|1066290|604800/);
      expect(container.textContent).not.toContain("RESERVE EVIDENCE");
      const status = within(container.querySelector("details#reserve-feed-status") as HTMLElement);
      expect(status.getByText("Reason: source-age")).toBeDefined();
      expect(status.getByText("Source age: 12.3 days (budget 7 days)")).toBeDefined();
    });

    it("shows the source-type chip and keeps the provenance sentence out of the visible summary", () => {
      const { container } = renderSection({ reserves: STALE_USDC });
      expect(screen.getByRole("button", { name: "Attestation" })).toBeDefined();
      expect(container.querySelector("p.uppercase")).toBeNull();
      // Reachable without hover: it sits in the folded Sources footnote.
      expect(container.textContent).toContain("dated attestation, proof, or liveness check");
    });

    it("keeps the live composition in a dated disclosure when it differs from the reviewed slices", () => {
      renderSection({ reserves: STALE_USDC });
      const live = within(screen.getByLabelText("Live reserve feed composition"));
      expect(live.getByText("<3-Month U.S. Treasuries")).toBeDefined();
      expect(screen.getAllByText(/Report as of|Source as of|Composition as of/).length).toBeGreaterThan(0);
      // The live shares never reach the summary visual.
      expect(screen.getByRole("figure").getAttribute("aria-label")).not.toContain("49.9");
    });

    it("retries from the Feed status disclosure after a failed fetch and keeps the reviewed visual", () => {
      const onRetry = vi.fn();
      renderSection({ reserves: makeReserves({ mode: "curated-fallback" }), reserveFetchError: new Error("boom"), onRetry });
      expect(screen.getByRole("button", { name: "Live reserve feed unavailable" })).toBeDefined();
      expect(screen.getByRole("figure").getAttribute("aria-label")).toContain("U.S. Treasury bills 80%");
      fireEvent.click(screen.getByRole("button", { name: "Retry", hidden: true }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it("explains an empty module when the feed failed and no reviewed slices exist", () => {
      const onRetry = vi.fn();
      const { container } = renderSection({ coin: NO_REVIEW_COIN, qualitySummary: null, reserveFetchError: new Error("upstream exploded"), onRetry });
      expect(container.textContent).toContain("Reserve composition could not be loaded.");
      expect(container.textContent).not.toContain("upstream exploded");
      expect(screen.getAllByRole("button", { name: "Retry", hidden: true }).length).toBeGreaterThan(0);
    });
  });

  it("never promotes the live feed into the summary when no slices are reviewed", () => {
    const { container } = renderSection({
      coin: NO_REVIEW_COIN,
      qualitySummary: null,
      reserves: makeReserves({
        metadata: { sourceTimestamp: Date.parse("2026-09-24T00:00:00Z") / 1000 },
        reserves: [
          { name: "GhoDirectFacilitator GSM Arbitrum", pct: 60, risk: "high", issuerOrObligor: "Aave DAO Arbitrum GHO Reserve and remote GSM" },
          { name: "Cash", pct: 40, risk: "very-low" },
        ],
      }),
    });
    expect(screen.getByText("No reviewed reserve composition yet.")).toBeDefined();
    expect(screen.queryByRole("figure")).toBeNull();
    expect(screen.queryByRole("group", { name: "Reserve facts" })).toBeNull();
    // The live numbers appear only inside the dated, folded disclosure.
    const disclosure = screen.getByText("Live reserve feed").closest("details") as HTMLElement;
    expect(disclosure.textContent).toContain("Source as of 2026-09-24");
    expect(disclosure.textContent).toContain("do not drive the Safety Score basis");
    expect(within(disclosure).getByText("Cash")).toBeDefined();
    expect(container.textContent?.replace(disclosure.textContent ?? "", "")).not.toMatch(/60%|40%/);
  });

  it("draws the reviewed curated slices when no quality summary exists, with no quality facts", () => {
    const curated = {
      ...COIN,
      reserves: [
        { name: "Liquid Cash strategy basket", pct: 81.3, risk: "medium" as const, assetClass: "cash" as const },
        { name: "BTC", pct: 9.8, risk: "medium" as const },
        { name: "ETH / LST", pct: 7.6, risk: "low" as const },
        { name: "Other", pct: 1.3, risk: "high" as const },
      ],
    };
    const { container } = renderSection({
      coin: curated,
      qualitySummary: null,
      reserves: makeReserves({
        metadata: { sourceTimestamp: Date.parse("2026-10-06T00:00:00Z") / 1000 },
        reserves: [{ name: "Live strategy", pct: 100, risk: "low" }],
      }),
    });
    expect(screen.getByRole("figure").getAttribute("aria-label"))
      .toBe("Reviewed reserve slices: Liquid Cash strategy basket 81.3%, BTC 9.8%, ETH / LST 7.6%, Other 1.3%");
    expect(screen.queryByText("No reviewed reserve composition yet.")).toBeNull();
    // Only the structural fact survives; quality-only facts, ladder and slice detail need the summary.
    const facts = within(screen.getByRole("group", { name: "Reserve facts" }));
    expect(facts.getByText("Top position")).toBeDefined();
    expect(facts.queryByText("Liquid ≤ 1 day")).toBeNull();
    expect(facts.queryByText("Unresolved reserve exposure")).toBeNull();
    expect(screen.queryByText("Liquidity ladder")).toBeNull();
    expect(screen.queryByText("Slice detail & risk factors")).toBeNull();
    // The live feed stays in its dated disclosure and is worded as differing.
    const disclosure = screen.getByText("Live reserve feed").closest("details") as HTMLElement;
    expect(disclosure.textContent).toContain("can differ from the reviewed slices");
    expect(within(disclosure).getByText("Live strategy")).toBeDefined();
    expect(container.textContent?.replace(disclosure.textContent ?? "", "")).not.toContain("Live strategy");
  });

  it("reports a live feed with identical shares but different assets as different", () => {
    renderSection({
      qualitySummary: { ...SUMMARY, sliceCount: 1, slices: [{ ...SUMMARY.slices[0]!, name: "ETH", pct: 100 }] },
      reserves: makeReserves({ reserves: [{ name: "USDC", pct: 100, risk: "low" }] }),
    });
    const disclosure = screen.getByText("Live reserve feed").closest("details") as HTMLElement;
    expect(disclosure.textContent).toContain("can differ from the reviewed slices");
    expect(within(disclosure).getByText("USDC")).toBeDefined();
  });

  it("still exposes a live feed that matches the reviewed slices, worded as matching", () => {
    renderSection({
      reserves: makeReserves({
        reserves: [{ name: "U.S. Treasury bills", pct: 80.2, risk: "very-low" }, { name: "Bank deposits", pct: 19.8, risk: "very-low" }],
      }),
    });
    const disclosure = screen.getByText("Live reserve feed").closest("details") as HTMLElement;
    expect(disclosure.textContent).toContain("matches the reviewed slices");
  });
});
