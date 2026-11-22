// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { ReserveResult } from "@shared/lib/reserve-templates";
import type { ReserveQualityClientSummary } from "@/lib/stablecoin-detail-reserve-quality-client";
import type { ReserveLookThroughClientSummary } from "@/lib/stablecoin-detail-reserve-look-through-client";
import { ReservesSection, type ReservesSectionProps } from "../reserves-section";
import { projectReserveQualityClientSummary } from "@/lib/stablecoin-detail-reserve-quality-client";
import { buildStablecoinDetailClientCoin } from "@/lib/stablecoin-detail-client-coin";
import { projectReserveLookThroughClientSummary } from "@/lib/stablecoin-detail-reserve-look-through-client";

vi.mock("next/link", async () => (await import("@/test-utils/frontend")).createNextLinkMock());

const COIN = TRACKED_META_BY_ID.get("iusd-infinifi")!;
const AMBER_VALUE_CLASS = "text-state-warn";
const NO_REVIEW_COIN = { ...COIN, reserves: [] };

const SUMMARY: ReserveQualityClientSummary = {
  evidenceBasis: "full-composition", populationId: COIN.id, chipLabel: "Highly liquid",
  chipToneClass: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700",
  lede: "2 reviewed reserve slices — 100% convertible within one day.",
  ladder: [{ key: "immediate", label: "Immediate", pct: 20 }, { key: "over-seven-days", label: "> 7 days", pct: 12.9 }, { key: "one-day", label: "≤ 1 day", pct: 67.1 }],
  liquidWithinOneDayPct: 87.1, unknownHorizonPct: 0, unidentifiedObligorsPct: 0, selfExposurePct: null, topPositionName: null, topPositionPct: null,
  asOf: "2026-06-30", sliceCount: 2, confidenceLabel: "Verified", reviewedAt: "2026-07-18",
  compositionBasis: "Monthly attestation composition table.", knownUnknownExposureNote: "No undisclosed obligors in the attested basket.",
  slices: [
    { key: "bank:1", name: "Bank deposits", pct: 20, assetClassLabel: "Bank deposits", horizonLabel: "Immediate", riskLabel: "Very low", risk: "very-low", obligor: "Regulated banks", riskFactorLabels: [] },
    { key: "bills:0", name: "U.S. Treasury bills", pct: 80, assetClassLabel: "Treasury bills", horizonLabel: "≤ 1 day", riskLabel: "Very low", risk: "very-low", obligor: "U.S. Treasury", riskFactorLabels: ["duration", "liquidity"] },
  ],
  sources: [{ label: "Circle reserve report", url: "https://example.com/reserves" }],
};

const makeReserves = (overrides: Partial<ReserveResult> = {}): ReserveResult => ({
  reserves: [{ name: "Live farm", pct: 100, risk: "low" }], estimated: false, mode: "live", liveAt: 1_700_000_000, source: "fixture", ...overrides,
});

const STALE_USDC = makeReserves({
  mode: "live-stale", source: "circle-transparency", displayBadge: { kind: "proof", label: "Attestation" },
  provenance: { evidenceClass: "independent", sourceModel: "dynamic-mix", scoringEligible: false },
  metadata: { sourceTimestamp: Date.parse("2026-09-24T00:00:00Z") / 1000 },
  sync: {
    enabled: true, status: "error", stale: true, bootstrap: false, failureCategory: "validation",
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

const renderSection = (props: Partial<ReservesSectionProps> = {}) =>
  render(<ReservesSection coin={COIN} reserves={null} reserveFetchError={null} qualitySummary={SUMMARY} {...props} />);
const rankedList = () => within(screen.getByRole("list", { name: "Reserve composition, largest first" }));
const findProvenanceFold = (container: HTMLElement, url: string) =>
  Array.from(container.querySelectorAll("details")).find((fold) => fold.querySelector(`a[href="${url}"]`));

function factValue(label: string): HTMLElement {
  const value = screen.getByText(label).nextElementSibling;
  if (!(value instanceof HTMLElement)) throw new Error(`No value for fact ${label}`);
  return value;
}

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("ReservesSection", () => {
  it("labels the three verified USDU claims in the ranked reserve rows", () => {
    const coin = buildStablecoinDetailClientCoin(TRACKED_META_BY_ID.get("usdu-usdu-finance")!);
    renderSection({ coin, qualitySummary: coin.reserveQualitySummary });
    const labels = rankedList().getAllByText(/^Self-referential claim \(/);
    expect(labels.map((l) => l.textContent)).toEqual(coin.reserves!.filter((r) => r.name.startsWith("Self-referential claim (")).map((r) => r.name));
    expect(labels).toHaveLength(3);
  });

  it.each(["zaru-blocktower", "stusd-stoneyield"])("keeps selected historical slices contextual rather than whole-basket quality (%s)", (id) => {
    const coin = TRACKED_META_BY_ID.get(id)!;
    const lookThrough = projectReserveLookThroughClientSummary(coin, TRACKED_META_BY_ID);
    expect(lookThrough).toBeNull();
    const { container } = renderSection({ coin, qualitySummary: projectReserveQualityClientSummary(coin), lookThrough });
    expect(screen.queryByText(/Highly liquid|Liquid ≤ 1 day/)).toBeNull();
    expect(screen.queryByLabelText("Liquidity horizon ladder")).toBeNull();
    expect(container.textContent).not.toContain("100% convertible within one day");
    expect(screen.getByRole("figure").getAttribute("aria-label")).toContain("Contextual reserve slices");
    expect(container.textContent).toContain(coin.reserves![0]!.name);
    expect(container.textContent).toContain(coin.reserveReview!.compositionBasis);
  });

  it.each([["usde-ethena", "Confidence: Verified"], ["usdon-ondo", "Confidence: Probable"]])("shows review provenance without a verdict, ladder or slice detail for %s", (id, confidence) => {
    const coin = TRACKED_META_BY_ID.get(id)!;
    const qualitySummary = projectReserveQualityClientSummary(coin)!;
    const { container } = renderSection({ coin, qualitySummary, reserves: null });
    expect(qualitySummary.evidenceBasis).toBe("provenance-only");
    expect(screen.getByText(confidence)).toBeDefined();
    expect(container.textContent).toContain(`Reviewed ${coin.reserveReview!.reviewedAt}`);
    expect(container.innerHTML).toContain(coin.reserveReview!.sources[0]!.url);
    expect(container.textContent).toContain(coin.reserveReview!.compositionBasis!);
    expect(container.textContent).toContain(coin.reserveReview!.knownUnknownExposure!);
    expect(screen.getByRole("figure").getAttribute("aria-label")).toContain(coin.reserves![0]!.name);
    expect(screen.queryByText(/Highly liquid|Liquidity ladder|Liquid ≤ 1 day|Slice detail & risk factors/)).toBeNull();
    expect(container.textContent).not.toContain("convertible within one day");
  });

  it("builds the module from reviewed slices with anchors, dates, folded provenance, and hover coupling", () => {
    const { container } = renderSection();
    const region = screen.getByRole("region", { name: "Reserves" });
    expect(region.id).toBe("reserves");
    const alias = region.querySelector("#reserve-quality")!;
    expect(alias.compareDocumentPosition(screen.getByRole("figure")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelectorAll("#reserve-quality")).toHaveLength(1);
    expect(screen.getByText("Highly liquid")).toBeDefined();
    expect(screen.getByText(SUMMARY.lede!)).toBeDefined();
    expect(container.querySelectorAll('[role="figure"]')).toHaveLength(1);
    expect(screen.getByRole("figure").getAttribute("aria-label"))
      .toBe("Reviewed reserve slices: U.S. Treasury bills 80% (very low risk), Bank deposits 20% (very low risk)");
    expect(rankedList().getAllByRole("listitem").map((r) => r.textContent)).toEqual([
      "U.S. Treasury billsVery low risk · Treasury bills80.0%", "Bank depositsVery low risk · Bank deposits20.0%",
    ]);
    expect(screen.queryByLabelText("Reserve risk tiers")).toBeNull();
    expect(screen.queryByRole("group", { name: "Reserve facts" })).toBeNull();
    expect(screen.queryByText(/Top position|As of/)).toBeNull();
    expect(container.textContent).toContain("Reserves as of 2026-06-30 · Reviewed 2026-07-18");
    expect(container.innerHTML).toContain("https://example.com/reserves");

    const segments = Array.from(container.querySelectorAll('[role="figure"] > span[data-tier-step]'));
    expect(segments.map((s) => s.getAttribute("data-tier-step"))).toEqual(["0", "1"]);
    const rows = Array.from(container.querySelectorAll('ol[aria-label="Reserve composition, largest first"] > li'));
    fireEvent.mouseEnter(rows[1]!);
    expect([segments[1]!.getAttribute("data-highlighted"), segments[0]!.getAttribute("data-highlighted")]).toEqual(["true", null]);
    fireEvent.mouseLeave(rows[1]!);
    expect(segments[1]!.getAttribute("data-highlighted")).toBeNull();
  });

  it("lists eight slices, folds the rest, and keeps every folded slice in the bar and its accessible name", () => {
    const slices = [40, 20, 10, 8, 6, 5, 4, 3, 2, 2].map((pct, i) => ({
      ...SUMMARY.slices[0]!, key: `reviewed:${i}`, name: `Reviewed ${i}`, assetClassLabel: `Class ${i}`, pct, risk: i === 9 ? "high" as const : "very-low" as const,
    }));
    renderSection({ qualitySummary: { ...SUMMARY, slices, sliceCount: slices.length } });
    const label = screen.getByRole("figure").getAttribute("aria-label");
    expect(label).toContain("Reviewed 8 2% (very low risk), Reviewed 9 2% (high risk)");
    expect(label).not.toContain("Unreviewed");
    expect(rankedList().getAllByRole("listitem")).toHaveLength(8);
    const rest = screen.getByLabelText("Remaining reserve slices");
    expect(within(rest).getAllByRole("listitem")).toHaveLength(2);
    expect(rest.closest("details")!.querySelector("summary")!.textContent).toContain("2 more slices · 4.0%");
    const detail = screen.getByLabelText("Reserve slices");
    expect(within(detail).getAllByRole("listitem")).toHaveLength(10);
    slices.forEach((s) => expect(within(detail).getByText(s.name)).toBeDefined());
  });

  it.each(["usdt-tether", "frax-frax"])("keeps the full real-registry basket weight and actual tiers in the bar for %s", (id) => {
    const coin = TRACKED_META_BY_ID.get(id)!;
    const qualitySummary = projectReserveQualityClientSummary(coin)!;
    renderSection({ coin, qualitySummary });
    const segments = Array.from(screen.getByRole("figure").children) as HTMLElement[];
    expect(segments.reduce((sum, s) => sum + Number.parseFloat(s.style.flex), 0)).toBeCloseTo(qualitySummary.slices.reduce((sum, s) => sum + s.pct, 0), 3);
    expect(segments.length).toBeLessThanOrEqual(8 + 5 + 1);
    if (qualitySummary.slices.length > 8) {
      expect(screen.getByLabelText("Remaining reserve slices").closest("details")!.querySelector("summary")!.textContent)
        .toContain(`${qualitySummary.slices.length - 8} more slices`);
    }
  });

  it("draws a partial slice with an unreviewed remainder and treats float dust as the whole basket", () => {
    const { unmount } = renderSection({ qualitySummary: { ...SUMMARY, slices: [{ ...SUMMARY.slices[0]!, pct: 72.5 }], sliceCount: 1 } });
    expect(screen.getByRole("figure").getAttribute("aria-label")).toContain("Unreviewed remainder 27.5%");
    expect(screen.getByText("Unreviewed remainder").closest("li")!.textContent).toContain("27.5%");
    unmount();

    const dust = [33.4, 33.3, 33.3].map((pct, i) => ({ ...SUMMARY.slices[0]!, key: `d:${i}`, name: `Dust ${i}`, pct }));
    renderSection({ qualitySummary: { ...SUMMARY, slices: dust, sliceCount: dust.length } });
    expect(screen.getByRole("figure").getAttribute("aria-label")).not.toContain("Unreviewed");
    expect(screen.queryByText("Unreviewed remainder")).toBeNull();
  });

  it("folds review notes and sources together last under one footer line", () => {
    const { container } = renderSection({ reserves: STALE_USDC });
    const folds = Array.from(container.querySelectorAll("details"));
    const provenance = folds.filter((f) => f.querySelector(`a[href="${SUMMARY.sources[0]!.url}"]`));
    expect(provenance).toHaveLength(1);
    expect(folds.at(-1)).toBe(provenance[0]);
    expect(provenance[0]!.open).toBe(false);
    expect(provenance[0]!.textContent).toContain(SUMMARY.compositionBasis!);
    expect(provenance[0]!.textContent).toContain(SUMMARY.knownUnknownExposureNote!);
    expect(screen.getByLabelText("Reserve slices").closest("details")!.textContent).not.toContain(SUMMARY.compositionBasis!);
    expect(container.textContent?.split(SUMMARY.compositionBasis!).length).toBe(2);
    expect(provenance[0]!.querySelector("summary")?.textContent).toMatch(/\b3\b/);
  });

  it("calibrates liquid ≤ 1 day, unresolved exposure, and concentration facts accurately", () => {
    const NO_VERDICT = { ...SUMMARY, lede: null };
    const { rerender } = renderSection({ qualitySummary: NO_VERDICT });
    expect(factValue("Liquid ≤ 1 day").className).not.toContain(AMBER_VALUE_CLASS);
    expect(factValue("Liquid ≤ 1 day").textContent).toBe("87.1%");
    expect(factValue("Unresolved exposure").className).not.toContain(AMBER_VALUE_CLASS);
    expect(rankedList().getAllByRole("listitem")[0]!.querySelector(`.${AMBER_VALUE_CLASS}`)).toBeNull();

    rerender(<ReservesSection coin={COIN} reserves={null} reserveFetchError={null} qualitySummary={{ ...NO_VERDICT, liquidWithinOneDayPct: 30, unknownHorizonPct: 10 }} />);
    expect(factValue("Liquid ≤ 1 day").className).toContain(AMBER_VALUE_CLASS);
    expect(factValue("Liquid ≤ 1 day").textContent).toBe("≥ 30%");

    rerender(<ReservesSection coin={COIN} reserves={null} reserveFetchError={null} qualitySummary={{ ...NO_VERDICT, liquidWithinOneDayPct: 9.9, unknownHorizonPct: 90.1 }} />);
    expect(factValue("Liquid ≤ 1 day").className).not.toContain(AMBER_VALUE_CLASS);

    rerender(<ReservesSection coin={COIN} reserves={null} reserveFetchError={null} qualitySummary={{ ...NO_VERDICT, liquidWithinOneDayPct: 0, unknownHorizonPct: 100 }} />);
    expect(screen.queryByText(/Liquid ≤ 1 day|Not published/)).toBeNull();

    rerender(<ReservesSection coin={COIN} reserves={null} reserveFetchError={null} qualitySummary={SUMMARY} />);
    expect(screen.getByText(SUMMARY.lede!)).toBeDefined();
    expect(screen.queryByText("Liquid ≤ 1 day")).toBeNull();

    const flagged = { ...SUMMARY, unidentifiedObligorsPct: 12.6, topPositionName: "Hedged basis book", topPositionPct: 62.4 };
    rerender(<ReservesSection coin={COIN} reserves={null} reserveFetchError={null} qualitySummary={{ ...flagged, lede: null }} />);
    expect(factValue("Unresolved exposure").textContent).toBe("12.6%");
    expect(factValue("Unresolved exposure").className).toContain(AMBER_VALUE_CLASS);
    expect(rankedList().getAllByRole("listitem")[0]!.querySelector(`.${AMBER_VALUE_CLASS}`)?.textContent).toContain("80.0%");
    expect(screen.queryByText("Top position")).toBeNull();

    rerender(<ReservesSection coin={COIN} reserves={null} reserveFetchError={null} qualitySummary={{ ...flagged, lede: "2 reviewed reserve slices — 100% convertible within one day. 12.6% of the basket has unresolved reserve exposure." }} />);
    expect(screen.queryByRole("group", { name: "Reserve facts" })).toBeNull();
  });

  describe("wrapper look-through", () => {
    const WRAPPER_SUMMARY: ReserveQualityClientSummary = {
      ...SUMMARY, sliceCount: 1,
      slices: [{ key: "vault:0", name: "PAR staking vault shares", pct: 100, assetClassLabel: "Protocol position", horizonLabel: "≤ 1 day", riskLabel: "Medium", risk: "medium", obligor: "Vault and PAR", riskFactorLabels: [] }],
    };
    const LOOK_THROUGH: ReserveLookThroughClientSummary = {
      parentId: "par-coin", parentSymbol: "PAR", parentReviewedAt: "2026-09-30", parentCompositionAsOf: "2026-09-15",
      parentSources: [{ label: "Parent reserve report", url: "https://example.com/parent-reserves" }],
      slices: [
        { key: "cash:0", name: "Liquid cash strategy basket", pct: 70, risk: "medium", obligor: null, assetClassLabel: "Cash" },
        { key: "btc:1", name: "BTC collateral", pct: 30, risk: "high", obligor: null, assetClassLabel: null },
      ],
    };

    it("keeps parent's reviewed own-liability labels in sFRAX's ranked list", () => {
      const coin = buildStablecoinDetailClientCoin(TRACKED_META_BY_ID.get("sfrax-frax")!, { parentById: TRACKED_META_BY_ID });
      renderSection({ coin, qualitySummary: coin.reserveQualitySummary, lookThrough: coin.reserveLookThrough });
      for (const name of ["sFRAX", "Legacy FRAX (ethereum)"]) expect(rankedList().getByText(`Self-referential claim (${name})`)).toBeDefined();
    });

    it("draws parent slices labelled via parent, words verdict over parent slices, and folds provenance dates", () => {
      const { container } = renderSection({ qualitySummary: WRAPPER_SUMMARY, lookThrough: LOOK_THROUGH });
      expect(container.querySelectorAll('[role="figure"]')).toHaveLength(1);
      const label = screen.getByRole("figure").getAttribute("aria-label") ?? "";
      for (const t of ["Liquid cash strategy basket 70%", "BTC collateral 30%", "PAR staking vault shares"]) expect(label).toContain(t);
      const via = screen.getByRole("link", { name: "PAR" });
      expect(via.getAttribute("href")).toBe("/stablecoin/par-coin/#reserves");
      expect(via.closest("p")?.textContent).toMatch(/PAR staking vault shares.*via PAR/);
      expect(screen.queryByText(WRAPPER_SUMMARY.chipLabel!)).toBeNull();
      expect(screen.queryByText(SUMMARY.lede!)).toBeNull();
      expect(screen.queryByRole("group", { name: "Reserve facts" })).toBeNull();
      expect(screen.queryByText(/Liquidity ladder|Not published/)).toBeNull();
      const verdict = screen.getByText(/^Via PAR: 2 reviewed slices/);
      expect(verdict.textContent).toContain("Liquid cash strategy basket");
      expect(verdict.textContent).toContain("70%");

      const provenance = findProvenanceFold(container, LOOK_THROUGH.parentSources[0]!.url)!;
      expect(provenance.open).toBe(false);
      expect(provenance.textContent).toContain("PAR reserves as of 2026-09-15, reviewed 2026-09-30");
      expect(container.textContent?.split("PAR reserves as of").length).toBe(2);
    });

    it("handles matching parent review dates, missing parent dates, duplicate sources, and fallbacks", () => {
      const { container, rerender } = renderSection({ qualitySummary: WRAPPER_SUMMARY, lookThrough: { ...LOOK_THROUGH, parentCompositionAsOf: "2026-09-30" } });
      let prov = findProvenanceFold(container, LOOK_THROUGH.parentSources[0]!.url)!;
      expect(prov.textContent).toContain("PAR reserves reviewed 2026-09-30");
      expect(prov.textContent).not.toContain("as of 2026-09-30");

      rerender(<ReservesSection coin={COIN} reserves={makeReserves({ reserves: [] })} reserveFetchError={null} qualitySummary={WRAPPER_SUMMARY} lookThrough={{ ...LOOK_THROUGH, parentReviewedAt: null, parentCompositionAsOf: null }} />);
      prov = findProvenanceFold(container, LOOK_THROUGH.parentSources[0]!.url)!;
      expect(prov.textContent).toContain("IUSD basis as of 2026-06-30");
      expect(prov.textContent).toContain("Live feed: ");

      rerender(<ReservesSection coin={COIN} reserves={null} reserveFetchError={null} qualitySummary={WRAPPER_SUMMARY} lookThrough={{ ...LOOK_THROUGH, parentSources: [...LOOK_THROUGH.parentSources, ...WRAPPER_SUMMARY.sources] }} />);
      expect(findProvenanceFold(container, WRAPPER_SUMMARY.sources[0]!.url)!.querySelectorAll(`a[href="${WRAPPER_SUMMARY.sources[0]!.url}"]`)).toHaveLength(1);

      rerender(<ReservesSection coin={COIN} reserves={null} reserveFetchError={null} qualitySummary={SUMMARY} lookThrough={LOOK_THROUGH} />);
      expect(screen.getByRole("figure").getAttribute("aria-label")).toBe("Reviewed reserve slices: U.S. Treasury bills 80% (very low risk), Bank deposits 20% (very low risk)");
      expect(screen.queryByRole("link", { name: "PAR" })).toBeNull();

      rerender(<ReservesSection coin={COIN} reserves={null} reserveFetchError={null} qualitySummary={WRAPPER_SUMMARY} lookThrough={{ ...LOOK_THROUGH, slices: [{ ...LOOK_THROUGH.slices[0]!, pct: 0 }] }} />);
      expect(screen.getByRole("figure").getAttribute("aria-label")).toContain("PAR staking vault shares 100%");
      expect(screen.queryByRole("link", { name: "PAR" })).toBeNull();
    });

    it("never prints a wrapper's single-slice chip or liquidity facts over the parent basket", () => {
      const coin = TRACKED_META_BY_ID.get("usdcx-movement")!;
      const qualitySummary = projectReserveQualityClientSummary(coin);
      const lookThrough = projectReserveLookThroughClientSummary(coin, TRACKED_META_BY_ID);
      expect(qualitySummary?.populationId).toBe(coin.id);
      expect(qualitySummary?.populationId).not.toBe(lookThrough?.parentId);
      expect(qualitySummary?.chipLabel).toBe("Opaque exit");
      renderSection({ coin, qualitySummary, lookThrough });
      expect(screen.queryByText(/Opaque exit|Not published/)).toBeNull();
      expect(screen.queryByRole("group", { name: "Reserve facts" })).toBeNull();
      expect(screen.getByText(/^Via /).textContent).toContain(`${lookThrough!.parentSymbol}: ${lookThrough!.slices.length} reviewed slices`);
    });
  });

  describe("reserve feed", () => {
    it("keeps source-age stale feed out of header, shows chip, and keeps live composition in a dated disclosure", () => {
      const { container } = renderSection({ reserves: STALE_USDC });
      expect(screen.queryByRole("button", { name: /Reserve feed stale/ })).toBeNull();
      expect(container.querySelector("details#reserve-feed-status")).toBeNull();
      expect(container.textContent).not.toMatch(/Validation failed|1066290|604800|RESERVE EVIDENCE/);
      expect(screen.getByRole("button", { name: "Attestation" })).toBeDefined();
      expect(container.textContent).toContain("dated attestation, proof, or liveness check");
      expect(within(screen.getByLabelText("Live reserve feed composition")).getByText("<3-Month U.S. Treasuries")).toBeDefined();
      expect(screen.getAllByText(/Report as of|Source as of|Composition as of/).length).toBeGreaterThan(0);
      expect(document.body.textContent?.split("Checked ").length).toBe(2);
      expect(screen.getByRole("figure").getAttribute("aria-label")).not.toContain("49.9");
      cleanup();
      renderSection({ reserves: STALE_USDC, scoreAdmissionNote: "Why." });
      expect(document.body.textContent).toContain("Not used by the Safety Score. Why.");
      expect(document.body.textContent).toContain("above, which the Safety Score does not use.");
    });

    it("dates an undated reviewed-config feed only when it replays the reviewed basket", () => {
      const replay = (reserves: ReserveResult["reserves"]) => makeReserves({ metadata: { sourceTimestamp: Date.parse("2026-09-24T00:00:00Z") / 1000, details: { compositionSource: "reviewed-config" } }, reserves });
      const { container, unmount } = renderSection({ reserves: replay([{ name: "U.S. Treasury bills", pct: 80, risk: "very-low" }, { name: "Bank deposits", pct: 20, risk: "very-low" }]) });
      expect(container.textContent).toContain("Composition as of 2026-06-30 · Checked");
      expect(container.textContent).not.toContain("Composition date unavailable");
      unmount();
      expect(renderSection({ reserves: replay([{ name: "Gold", pct: 100, risk: "very-low" }]) }).container.textContent).toContain("Composition date unavailable");
    });

    it("handles retained refetch errors, first-fetch failure retry, and empty unreviewed failure", () => {
      const { unmount } = renderSection({ reserves: makeReserves({ mode: "curated-fallback" }), reserveFetchError: new Error("boom") });
      expect(screen.queryByRole("button", { name: "Live reserve feed unavailable" })).toBeNull();
      unmount();

      const onRetry = vi.fn();
      const { container, unmount: u2 } = renderSection({ reserves: null, reserveFetchError: new Error("boom"), onRetry });
      expect(screen.getByRole("button", { name: "Live reserve feed unavailable" })).toBeDefined();
      expect(container.querySelector("details#reserve-feed-status")).not.toBeNull();
      expect(screen.getByRole("figure").getAttribute("aria-label")).toContain("U.S. Treasury bills 80%");
      fireEvent.click(screen.getByRole("button", { name: "Retry", hidden: true }));
      expect(onRetry).toHaveBeenCalledTimes(1);
      u2();

      const empty = renderSection({ coin: NO_REVIEW_COIN, qualitySummary: null, reserveFetchError: new Error("upstream exploded"), onRetry });
      expect(empty.container.textContent).toContain("Reserve composition could not be loaded.");
      expect(empty.container.textContent).not.toContain("upstream exploded");
      expect(screen.getAllByRole("button", { name: "Retry", hidden: true }).length).toBeGreaterThan(0);
    });
  });

  it("never promotes unreviewed live feed into summary, draws curated slices without quality facts, and detects asset mismatches", () => {
    const { container, unmount } = renderSection({
      coin: NO_REVIEW_COIN, qualitySummary: null,
      reserves: makeReserves({ metadata: { sourceTimestamp: Date.parse("2026-09-24T00:00:00Z") / 1000 }, reserves: [{ name: "GhoDirectFacilitator GSM Arbitrum", pct: 60, risk: "high", issuerOrObligor: "Aave DAO Arbitrum GHO Reserve and remote GSM" }, { name: "Cash", pct: 40, risk: "very-low" }] }),
    });
    expect(screen.getByText("No reviewed reserve composition yet.")).toBeDefined();
    expect(screen.queryByRole("figure")).toBeNull();
    expect(screen.queryByRole("group", { name: "Reserve facts" })).toBeNull();
    const disclosure = screen.getByText("Live reserve feed").closest("details") as HTMLElement;
    expect(disclosure.textContent).toContain("Source as of 2026-09-24");
    expect(disclosure.textContent).toContain("do not drive the Safety Score basis");
    expect(within(disclosure).getByText("Cash")).toBeDefined();
    expect(container.textContent?.replace(disclosure.textContent ?? "", "")).not.toMatch(/60%|40%/);
    unmount();

    const curated = { ...COIN, reserves: [{ name: "Liquid Cash strategy basket", pct: 81.3, risk: "medium" as const, assetClass: "cash" as const }, { name: "BTC", pct: 9.8, risk: "medium" as const }, { name: "ETH / LST", pct: 7.6, risk: "low" as const }, { name: "Other", pct: 1.3, risk: "high" as const }] };
    const { container: c2, unmount: u2 } = renderSection({ coin: curated, qualitySummary: null, reserves: makeReserves({ metadata: { sourceTimestamp: Date.parse("2026-10-06T00:00:00Z") / 1000 }, reserves: [{ name: "Live strategy", pct: 100, risk: "low" }] }) });
    expect(screen.getByRole("figure").getAttribute("aria-label")).toBe("Reviewed reserve slices: Liquid Cash strategy basket 81.3% (medium risk), BTC 9.8% (medium risk), ETH / LST 7.6% (low risk), Other 1.3% (high risk)");
    expect(screen.queryByRole("group", { name: "Reserve facts" })).toBeNull();
    expect(screen.queryByText(/No reviewed reserve composition yet\.|Liquidity ladder|Slice detail & risk factors/)).toBeNull();
    const d2 = screen.getByText("Live reserve feed").closest("details") as HTMLElement;
    expect(d2.textContent).toContain("can differ from the reviewed slices");
    expect(within(d2).getByText("Live strategy")).toBeDefined();
    expect(c2.textContent?.replace(d2.textContent ?? "", "")).not.toContain("Live strategy");
    u2();

    renderSection({ qualitySummary: { ...SUMMARY, sliceCount: 1, slices: [{ ...SUMMARY.slices[0]!, name: "ETH", pct: 100 }] }, reserves: makeReserves({ reserves: [{ name: "USDC", pct: 100, risk: "low" }] }) });
    const d3 = screen.getByText("Live reserve feed").closest("details") as HTMLElement;
    expect(d3.textContent).toContain("can differ from the reviewed slices");
    expect(within(d3).getByText("USDC")).toBeDefined();
  });
});
