// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { ReserveResult } from "@shared/lib/reserve-templates";
import type { ReserveQualityClientSummary } from "@/lib/stablecoin-detail-reserve-quality-client";
import { ReservesSection, type ReservesSectionProps } from "../reserves-section";

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
  it("renders nothing without reserves, a fetch error or a reviewed summary, and a skeleton while loading", () => {
    const { container, rerender } = renderSection({ coin: NO_REVIEW_COIN, qualitySummary: null });
    expect(container.innerHTML).toBe("");
    rerender(<ReservesSection coin={NO_REVIEW_COIN} reserves={null} reserveFetchError={null} isLoading />);
    expect(container.querySelector('section#reserves[aria-busy="true"]')).not.toBeNull();
  });

  it("builds the module from the reviewed slices: one visual, at most four facts, both anchors", () => {
    const { container } = renderSection();
    expect(container.querySelector("#reserves")).not.toBeNull();
    expect(container.querySelector("#reserve-quality")).not.toBeNull();
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

  it("draws a single-slice basket as a bar and omits the redundant top-position fact", () => {
    const { container } = renderSection({
      qualitySummary: {
        ...SUMMARY,
        sliceCount: 1,
        slices: [{ ...SUMMARY.slices[0]!, name: "ETH", pct: 100, obligor: "Ethereum" }],
      },
    });
    expect(container.textContent).toContain("ETH · 100%");
    expect(container.querySelector("[class*='pharos-chart-stage']")).toBeNull();
    expect(screen.queryByText("Top position")).toBeNull();
  });

  describe("reserve feed", () => {
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
    expect(disclosure.textContent).toContain("Source as of Sep 24, 2026");
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
