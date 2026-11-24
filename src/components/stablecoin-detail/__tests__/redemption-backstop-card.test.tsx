// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { act, render, within } from "@testing-library/react";
import { buildExitRouteUsage, RedemptionRouteSection, type ExitRouteUsageRow } from "../redemption-backstop-card";
import { buildRedemptionBackstopCardViewModel } from "../redemption-backstop-card-view-model";
import {
  formatRedemptionDocsProvenance,
  formatRedemptionRouteStatus,
  resolveScoreTier5,
  SCORE_TIER_5_CLASSES,
  SCORE_TIER_5_POLICY,
} from "@shared/lib/classification";
import { makeV9Card } from "@/test/fixtures/safety-score-v9";
import { REVIEWED_REDEMPTION_COVERAGE_DISPOSITIONS } from "@shared/data/coverage-dispositions/redemption-coverage-dispositions";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import type { SafetyScoreV9CurrentCard } from "@shared/types/safety-score-v9-public";
import { composeExitComponentScore } from "@shared/lib/exit-route-scoring";
import { REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS } from "@shared/lib/redemption-backstop-scoring";

function RedemptionBackstopCard({ entry }: { entry: RedemptionBackstopEntry }) {
  return <RedemptionRouteSection entry={entry} reportCard={null} coinId={entry.stablecoinId} />;
}

const BASE_ENTRY: RedemptionBackstopEntry = {
  stablecoinId: "eurc-circle", score: 65, dexLiquidityScore: 44, accessScore: 40, settlementScore: 65,
  executionCertaintyScore: 60, capacityScore: 100, outputAssetQualityScore: 100, costScore: 40,
  routeFamily: "offchain-issuer", accessModel: "issuer-api", settlementModel: "same-day",
  executionModel: "rules-based-nav", outputAssetType: "stable-single", provider: "supply-full-model",
  sourceMode: "estimated", resolutionState: "resolved", routeStatus: "open", routeStatusSource: "static-config",
  holderEligibility: "verified-customer", capacityConfidence: "heuristic", capacitySemantics: "eventual-only",
  feeConfidence: "undisclosed-reviewed", feeModelKind: "undisclosed-reviewed", modelConfidence: "low",
  immediateCapacityUsd: null, immediateCapacityRatio: null, feeBps: null, feeDescription: undefined,
  queueEnabled: false, methodologyVersion: "1.1", updatedAt: 1_700_000_000, capsApplied: [],
};

const DOCS: NonNullable<RedemptionBackstopEntry["docs"]> = {
  label: "Reserve feed", url: "https://example.com/reserves", reviewedAt: "2026-03-30", provenance: "proof-of-reserves",
  sources: [{ label: "Reserve feed", url: "https://example.com/reserves", supports: ["capacity"] }],
};

const NO_HOLDER_REASON_CODES: readonly string[] = [
  "pegkeeper-only", "no-holder-route", "borrower-repay-only", "secondary-market-only",
];

const ownRouteId = (e: RedemptionBackstopEntry = BASE_ENTRY) => `redemption:${e.stablecoinId}:${e.routeFamily}`;
const ownRouteKey = (e: RedemptionBackstopEntry = BASE_ENTRY) => `redemption:gen-1:${ownRouteId(e)}`;

type ExitAlt = NonNullable<SafetyScoreV9CurrentCard["breakdowns"]>["exit"]["alternatives"][number];
const makeAlt = (overrides: Partial<ExitAlt> = {}, entry: RedemptionBackstopEntry = BASE_ENTRY): ExitAlt => ({
  key: ownRouteKey(entry), routeId: ownRouteId(entry), lane: "redemption", label: "Issuer redemption",
  routeFamily: "issuer-redemption", score: null, included: false, exclusionReason: null,
  confidenceDimensions: null, capacityEvidenceTier: "unknown", rawSameNotionalCostBps: null, capacity: null,
  ...overrides,
});

function moduleRoot(): HTMLElement {
  const root = document.getElementById("redemption");
  if (!root) throw new Error("no #redemption module");
  return root;
}

function usageCells(
  card: SafetyScoreV9CurrentCard,
  entry: RedemptionBackstopEntry | null,
): Partial<Record<ExitRouteUsageRow["key"], ExitRouteUsageRow>> {
  const rows = buildExitRouteUsage(card, entry);
  if (!rows) throw new Error("no Exit usage rows");
  return Object.fromEntries(rows.map((row) => [row.key, row]));
}

function expectShortNotes(cells: ReturnType<typeof usageCells>) {
  for (const row of Object.values(cells)) {
    if (row?.note) expect(row.note.trim().split(/\s+/).length).toBeLessThanOrEqual(8);
  }
}

function onSummaryLayer(matches: readonly HTMLElement[]): HTMLElement {
  const visible = matches.filter((element) => element.closest("details") === null);
  expect(visible).toHaveLength(1);
  return visible[0]!;
}

const frames: FrameRequestCallback[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.setSystemTime(new Date((BASE_ENTRY.updatedAt + 300) * 1000));
});

afterEach(async () => {
  while (frames.length) await act(async () => { frames.shift()!(0); });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("RedemptionBackstopCard", () => {
  it.each([
    [null, null], [34.99, "t0"], [35, "t35"], [49.99, "t35"], [50, "t50"],
    [64.99, "t50"], [65, "t65"], [79.99, "t65"], [80, "t80"],
  ] as const)("keeps pill, component text and spectrum tiers aligned at %s", (score, tier) => {
    const entry = { ...BASE_ENTRY, score, accessScore: score };
    const model = buildRedemptionBackstopCardViewModel(entry);
    expect(resolveScoreTier5(score)).toBe(tier);
    expect(model.score).toBe(score);
    expect(model.scoreBreakdown.access.score).toBe(score);
    expect(model.scoreToneClass).toBe(tier === null
      ? "border-border/60 bg-muted/30 text-muted-foreground" : SCORE_TIER_5_CLASSES[tier].pill);
    expect(model.scoreBreakdown.access.textClass).toBe(tier === null
      ? "text-muted-foreground" : SCORE_TIER_5_CLASSES[tier].text);
    const { container } = render(<RedemptionBackstopCard entry={entry} />);
    const spectrum = container.querySelector('[aria-label^="Route score"]');
    if (tier === null) {
      expect(spectrum).toBeNull();
    } else {
      const band = SCORE_TIER_5_POLICY.find((entry) => entry.key === tier)!.label;
      expect(spectrum?.getAttribute("aria-label")).toBe(`Route score ${score} of 100, in the ${band} band of the redemption score track.`);
      expect(spectrum?.querySelectorAll(".h-1\\.5")[["t0", "t35", "t50", "t65", "t80"].indexOf(tier)]?.className)
        .toContain(SCORE_TIER_5_CLASSES[tier].fill);
      expect(Array.from(spectrum!.querySelectorAll("[aria-hidden='true'] > span")).map((node) => node.textContent))
        .toEqual(["<35", "35–49", "50–64", "65–79", "80+"]);
    }
  });

  it("draws a permissionless contract open only for any-holder eligibility, else closed and named by it", () => {
    const openContract = (holderEligibility: RedemptionBackstopEntry["holderEligibility"]): RedemptionBackstopEntry => ({
      ...BASE_ENTRY, accessModel: "permissionless-onchain", holderEligibility,
    });
    const rail = () => moduleRoot().querySelector('[role="img"][aria-label^="Redemption route"]')!;

    const anyHolder = render(<RedemptionBackstopCard entry={openContract("any-holder")} />);
    expect(rail().getAttribute("aria-label")).toContain("through Permissionless onchain access to");
    expect(rail().textContent).toContain("Permissionless");
    anyHolder.unmount();

    render(<RedemptionBackstopCard entry={openContract("issuer-discretionary")} />);
    expect(rail().getAttribute("aria-label")).toContain("through Permissionless onchain access (Issuer discretion) to");
    expect(rail().textContent).toContain("Issuer discretion");
    expect(rail().textContent).not.toContain("Permissionless");
  });

  it("uses the shared composition total and preserves component contribution order", () => {
    render(<RedemptionBackstopCard entry={BASE_ENTRY} />);
    const table = within(moduleRoot()).getByRole("table", { hidden: true });
    const rows = within(table).getAllByRole("row", { hidden: true });
    expect(rows.slice(1, 7).map((row) => row.querySelector("th")?.textContent)).toEqual([
      "Access", "Settlement", "Execution certainty", "Capacity", "Output quality", "Cost",
    ]);
    expect(rows[7]?.querySelector("td")?.textContent).toBe("70.8");
  });

  it("leaves the displayed total unavailable when a required component is missing", () => {
    render(<RedemptionBackstopCard entry={{ ...BASE_ENTRY, capacityScore: null, score: null }} />);
    const table = within(moduleRoot()).getByRole("table", { hidden: true });
    const weightedRow = within(table).getAllByRole("row", { hidden: true })[7]!;
    expect(weightedRow.querySelector("td")?.textContent).toBe("–");
  });

  it("explains a standalone cap using the shared composition delta rather than a separate sum", () => {
    const entry: RedemptionBackstopEntry = {
      ...BASE_ENTRY, score: 65, capsApplied: ["offchain-route-cap"],
      accessScore: 100, settlementScore: 100, executionCertaintyScore: 100,
      capacityScore: 100, outputAssetQualityScore: 100, costScore: 100,
    };
    const card = makeV9Card();
    const primary = card.breakdowns!.exit.primaryRoute!;
    const total = composeExitComponentScore({
      access: 100, settlement: 100, executionCertainty: 100,
      capacity: 100, outputAssetQuality: 100, cost: 100,
    }, REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS);
    card.breakdowns!.exit.primaryRoute = {
      ...primary, routeId: ownRouteId(entry), lane: "redemption",
      score: total, supportedComponentCeiling: total, confidenceFactor: 1,
      components: primary.components.map((component) => ({ ...component, score: 100 })), capsApplied: [],
    };
    const cells = usageCells(card, entry);
    expect(cells.counted?.figure).toBe(Math.round(total));
    expect(cells.counted?.note).toMatch(/^Route score carries its offchain-issuer cap at \d+$/);
    expect(cells.best?.value).toBe("This route");
    expectShortNotes(cells);
  });

  it.each(["new"])("reconciles exact route identity across opaque generation %s", (generation) => {
    const card = makeV9Card();
    card.breakdowns!.exit.primaryRoute = {
      ...card.breakdowns!.exit.primaryRoute!, key: `opaque:${generation}`, routeId: ownRouteId(), lane: "redemption", score: BASE_ENTRY.score,
    };
    const cells = usageCells(card, BASE_ENTRY);
    expect(cells.counted).toMatchObject({ figure: BASE_ENTRY.score, note: "Same as the route score" });
    expect(cells.best?.value).toBe("This route");
  });

  it.each([
    { name: "suffix collision", routeId: `redemption:other:${BASE_ENTRY.stablecoinId}:${BASE_ENTRY.routeFamily}`, lane: "redemption" },
    { name: "different lane", routeId: ownRouteId(), lane: "dex" },
    { name: "missing identity", routeId: undefined, lane: undefined },
  ] as const)("never guesses this route from an opaque key with $name", ({ routeId, lane }) => {
    const card = makeV9Card(), exit = card.breakdowns!.exit;
    exit.primaryRoute = {
      ...exit.primaryRoute!, key: `redemption:gen:${ownRouteId()}`, routeId, lane, score: BASE_ENTRY.score,
    } as unknown as NonNullable<typeof exit.primaryRoute>;
    exit.alternatives = [makeAlt({
      key: exit.primaryRoute.key, routeId, lane, label: "Unrelated route", score: 37, included: true, capacityEvidenceTier: "documented",
    } as unknown as Partial<ExitAlt>)];
    const selected = usageCells(card, BASE_ENTRY);
    expect(selected.counted).toMatchObject({ figure: null, value: "Not counted", note: "Not in the Exit evaluation" });
    expect(selected.best?.figure).toBe(BASE_ENTRY.score);
    expect(selected.best?.value).not.toBe("This route");
    exit.primaryRoute.score = null;
    const noQualifiedRoute = usageCells(card, BASE_ENTRY);
    expect(noQualifiedRoute.counted).toMatchObject({ figure: null, value: "Not counted" });
    expect(noQualifiedRoute.best?.value).toBe("None counted");
  });

  it("presents one standalone route score without the legacy effective exit score", () => {
    render(<RedemptionBackstopCard entry={BASE_ENTRY} />);
    const root = moduleRoot();
    const pills = Array.from(root.querySelectorAll<HTMLElement>("[data-slot='badge'][title^=\"This route's own score\"]"));
    expect(within(root).getByRole("heading", { name: /Issuer redemption route/ })).toBeTruthy();
    expect(pills.length).toBeGreaterThan(0);
    expect(pills[0]!.textContent).toBe("Route score 65");
    expect(pills[0]!.querySelector(".pharos-numeric")?.textContent).toBe("65");
    expect(root.textContent).not.toContain("58");
  });

  it("states the route score only in the pill and on its track, and no verdict restating the rail", () => {
    render(<RedemptionRouteSection entry={BASE_ENTRY} reportCard={makeV9Card()} coinId={BASE_ENTRY.stablecoinId} />);
    const root = moduleRoot();
    const summary = Array.from(root.querySelectorAll<HTMLElement>("p, [role='group']"))
      .filter((node) => node.closest("details") === null && node.closest("[data-slot='badge']") === null)
      .map((node) => node.textContent ?? "").join(" ");
    expect(summary).not.toContain("Route score");
    expect(Array.from(root.querySelectorAll("p.text-pretty")).filter((node) => node.closest("details") === null)).toHaveLength(0);
    expect(root.querySelector('[aria-label^="Route score"]')!.parentElement!.className).not.toContain("max-w-");
  });

  it("reconciles a different Exit score for the same route in place, naming the published cause", () => {
    const standalone: Record<string, number | null> = {
      access: BASE_ENTRY.accessScore, settlement: BASE_ENTRY.settlementScore,
      executionCertainty: BASE_ENTRY.executionCertaintyScore, capacity: BASE_ENTRY.capacityScore,
      outputAssetQuality: BASE_ENTRY.outputAssetQualityScore, cost: BASE_ENTRY.costScore,
    };
    const card = makeV9Card(), exit = card.breakdowns?.exit;
    if (!exit?.primaryRoute) throw new Error("fixture lacks an Exit primary route");
    exit.primaryRoute = {
      ...exit.primaryRoute, key: ownRouteKey(), routeId: ownRouteId(), lane: "redemption",
      score: 58, supportedComponentCeiling: 64, confidenceFactor: 0.9, capsApplied: [],
      components: exit.primaryRoute.components.map((c) => ({ ...c, score: standalone[c.key] ?? c.score })),
    };
    const cells = usageCells(card, BASE_ENTRY);
    expect(cells.counted).toMatchObject({ figure: 58, note: "0.9 evidence-confidence factor" });
    expectShortNotes(cells);
    render(<RedemptionRouteSection entry={BASE_ENTRY} reportCard={card} coinId={BASE_ENTRY.stablecoinId} />);
    const group = within(moduleRoot()).getByRole("group", { name: "How Exit uses this route" });
    expect(group.closest("details")).toBeNull();
    expect(group.textContent).toContain("Counted in Exit58");
  });

  it("explains why no route qualifies when the Exit pillar credits none, with the pillar score", () => {
    const card = makeV9Card(), exit = card.breakdowns?.exit;
    if (!exit) throw new Error("fixture lacks an Exit breakdown");
    const pillarScore = card.pillars.exit.score;
    if (pillarScore === null) throw new Error("fixture lacks an Exit pillar score");
    exit.primaryRoute = null;
    exit.alternatives = [makeAlt({ exclusionReason: "unsupported-same-notional-route" })];
    const cells = usageCells(card, BASE_ENTRY);
    expect(cells.counted).toMatchObject({ figure: null, value: "Not counted" });
    expect(cells.counted?.note).toMatch(/^No supported quote /);
    expect(cells.best).toMatchObject({ figure: null, value: "None counted" });
    expect(cells.best?.note).toContain(String(Math.round(pillarScore)));
    expectShortNotes(cells);
  });

  describe("an unrated route the Exit pillar still scores", () => {
    const unrated: RedemptionBackstopEntry = { ...BASE_ENTRY, score: null, capacityScore: null };
    const EXIT_SCORE = 37;
    type Tier = "documented" | "live-direct";
    const asAlternative = (card: SafetyScoreV9CurrentCard, tier: Tier) => {
      card.breakdowns!.exit.alternatives = [makeAlt({ score: EXIT_SCORE, included: true, capacityEvidenceTier: tier })];
    };
    const asPrimary = (card: SafetyScoreV9CurrentCard, tier: Tier) => {
      const exit = card.breakdowns!.exit;
      exit.primaryRoute = {
        ...exit.primaryRoute!, key: ownRouteKey(), score: EXIT_SCORE, capacityEvidenceTier: tier,
        routeId: ownRouteId(), lane: "redemption",
      };
    };
    function renderSummary(place: typeof asAlternative, tier: Tier, entry = unrated) {
      const card = makeV9Card();
      if (!card.breakdowns?.exit.primaryRoute) throw new Error("fixture lacks an Exit primary route");
      place(card, tier);
      const cells = usageCells(card, entry);
      const { unmount } = render(<RedemptionRouteSection entry={entry} reportCard={card} coinId={entry.stablecoinId} />);
      const root = moduleRoot();
      const verdict = root.querySelector("p.text-sm")?.textContent ?? "";
      const pills = root.querySelectorAll("[data-slot='badge'][title^='Not rated: ']").length;
      unmount();
      return { verdict, cells, pills };
    }

    it.each([
      ["Exit selects another route", asAlternative],
      ["Exit selects this route", asPrimary],
    ])("keeps the Not rated pill and names Exit's own score with the evidence it read when %s", (_, place) => {
      const documented = renderSummary(place, "documented");
      const live = renderSummary(place, "live-direct");
      expect(documented.pills).toBeGreaterThan(0);
      expect(documented.verdict).toBe("Only eventual capacity is published, and the route score needs immediate capacity.");
      expect(documented.verdict).not.toContain(String(EXIT_SCORE));
      expect(documented.cells.counted?.figure).toBe(EXIT_SCORE);
      expect(documented.cells.counted?.note).not.toBe(live.cells.counted?.note);
      expectShortNotes(documented.cells);
    });
  });

  it("renders unquantified eventual-only capacity without implying current-supply coverage", () => {
    const html = renderToStaticMarkup(<RedemptionBackstopCard entry={BASE_ENTRY} />);
    for (const s of [
      "Eventual Redeemability", "Not separately quantified", "Eventual route capacity is unquantified",
      "no current-supply coverage or immediate cash buffer is asserted",
    ]) expect(html).toContain(s);
    expect(html).not.toContain("eventual redeemability of current supply");
  });

  it("renders supply-wide eventual redeemability only with an admitted bound", () => {
    const html = renderToStaticMarkup(<RedemptionBackstopCard entry={{
      ...BASE_ENTRY, capacityBasis: "issuer-term-redemption", capacityConfidence: "documented-bound",
      capacityProfile: { eventualUsd: 30_000_000, scoringUsd: 30_000_000, scoringHorizon: "eventual", capacityProfileConfidence: "documented-bound" },
    }} />);
    for (const s of ["Eventual Redeemability", "$30.0M", "eventual redeemability of current supply under documented terms"]) expect(html).toContain(s);
    expect(html).not.toContain("Eventual route capacity is unquantified");
  });

  it("renders v4 capacity horizon, exit correlation, cost scenarios, and confidence detail", () => {
    const html = renderToStaticMarkup(<RedemptionBackstopCard entry={{
      ...BASE_ENTRY, capacitySemantics: "immediate-bounded", capacityConfidence: "live-direct",
      immediateCapacityUsd: 4_000_000, immediateCapacityRatio: 0.08, routeExitCorrelation: "independent-issuer-rail", eventualRedeemabilityScore: 82,
      capacityProfile: { immediateUsd: 4_000_000, dailyLimitUsd: 1_500_000, queuedUsd: 12_000_000, eventualUsd: 20_000_000, scoringUsd: 1_500_000, scoringHorizon: "daily", capacityProfileConfidence: "live-direct", modeledExitSizeUsd: 2_000_000 },
      costScenarioScores: { retail: 40, activeUser: 80, institutional: 100 },
      confidenceDetails: { capacityEvidenceQuality: 90, feeEvidenceQuality: 70, routeStatusFreshness: 80, holderCohortBreadth: 60, sourceQuality: 95, reviewedDocAgeDays: 12, reasons: ["live telemetry reviewed"] },
    }} />);
    for (const s of [
      "Daily Capacity", "$1.5M", "Current modeled capacity is daily-limited", "Scoring capacity: $1.5M", "Eventual capacity: $20.0M",
      "Modeled exit: $2.0M", "Eventual score: 82/100", "Retail cost: 40/100", "Active-user cost: 80/100", "Institutional cost: 100/100",
      "Confidence detail", "Capacity evidence: 90/100", "Fee evidence: 70/100", "Route freshness: 80/100", "Holder breadth: 60/100",
      "Source quality: 95/100", "Reviewed docs age: 12d", "live telemetry reviewed",
    ]) expect(html).toContain(s);
    expect(html).toMatch(/Exit correlation:\s*<span[^>]*>independent issuer rail</);
    expect(html).not.toContain("Queued capacity: $12.0M");
  });

  it("drops the score track for an unrated route and folds the resolution summary into review notes", () => {
    const unrated: RedemptionBackstopEntry = { ...BASE_ENTRY, score: null, sourceMode: "static", resolutionState: "missing-capacity", routeStatus: "unknown", modelConfidence: "low" };
    const scoredImages = render(<RedemptionBackstopCard entry={BASE_ENTRY} />).container.querySelectorAll("[role='img']").length;
    const { container } = render(<RedemptionBackstopCard entry={unrated} />);
    const viewModel = buildRedemptionBackstopCardViewModel(unrated);
    expect(container.querySelectorAll("[role='img']").length).toBe(scoredImages - 1);
    expect(within(container).getAllByText("Not rated").length).toBeGreaterThan(0);
    expect(onSummaryLayer(within(container).getAllByText(viewModel.modelConfidenceLabel))).toBeTruthy();
    expect(onSummaryLayer(within(container).getAllByText("No executable redemption capacity could be measured."))).toBeTruthy();
    expect(container.textContent).not.toMatch(/missing capacity|status unknown/i);
    expect(within(container).getByText(viewModel.resolutionSummary!).closest("details")?.querySelector("summary")?.textContent).toMatch(/Review notes/);
  });

  it("collapses an unrated route Exit does not count into one line and promotes Exit's best route", () => {
    const unrated: RedemptionBackstopEntry = { ...BASE_ENTRY, score: null, capacityScore: null, resolutionState: "missing-capacity", routeStatus: "unknown" };
    const card = makeV9Card(), primary = card.breakdowns!.exit.primaryRoute!;
    card.breakdowns!.exit.alternatives = [makeAlt({ exclusionReason: "unresolved-exit-output" }, unrated)];
    render(<RedemptionRouteSection entry={unrated} reportCard={card} coinId={unrated.stablecoinId} />);
    const root = moduleRoot();
    expect(root.querySelector("p.text-sm")?.textContent).toBe("No executable redemption capacity could be measured; Exit does not count it either (output asset unresolved).");
    const best = within(root).getByRole("group", { name: "How Exit uses this route" });
    expect(best.textContent).toContain(`Exit's best route${Math.round(primary.score!)}`);
    expect(best.closest(".pharos-inset")).toBeNull();
    expect(root.textContent).not.toMatch(/Not counted|Not credited|status unknown|missing capacity/i);
  });

  it("explains physical-delivery not-applicable capacity on uncredited alternatives", () => {
    const physical: RedemptionBackstopEntry = { ...BASE_ENTRY, score: null, capacityScore: null, resolutionState: "missing-capacity", routeStatus: "unknown", outputAssetType: "physical-commodity-delivery" };
    const card = makeV9Card();
    const alt = makeAlt({ routeFamily: "eventual-redemption", capacityEvidenceTier: "documented" }, physical);
    card.breakdowns!.exit.alternatives = [alt];
    const cells = usageCells(card, physical);
    expect(cells.counted).toMatchObject({ figure: null, value: "Not counted", note: "Physical delivery: USD capacity not applicable" });
    expectShortNotes(cells);
    expect(usageCells(card, BASE_ENTRY).counted?.note).toBe("Evaluated, not counted");
    card.breakdowns!.exit.alternatives = [{ ...alt, routeSuspension: { routeId: alt.routeId, channel: "Issuer", suspendedAt: "2026-10-01", reason: "Halted", reviewer: "ops", reviewedAt: "2026-10-02", sources: [{ url: "https://example.com", quote: "Halted" }] } }];
    expect(usageCells(card, physical).counted?.note).toBe("Evaluated, not counted");
    card.breakdowns!.exit.alternatives = [alt];
    render(<RedemptionRouteSection entry={physical} reportCard={card} coinId={physical.stablecoinId} />);
    expect(moduleRoot().querySelector("p.text-sm")?.textContent).toBe("Physical delivery has no USD redemption capacity to rate; Exit does not count it either.");
  });

  it("puts source citations and provenance inside the fold and the review date on the footer line", () => {
    render(<RedemptionBackstopCard entry={{ ...BASE_ENTRY, docs: DOCS }} />);
    const root = moduleRoot();
    const fold = within(root).getByRole("link", { name: "Reserve feed", hidden: true }).closest("details");
    expect(fold?.open).toBe(false);
    expect(fold?.contains(within(root).getByText(formatRedemptionDocsProvenance("proof-of-reserves")))).toBe(true);
    expect(within(root).getByText(/2026-03-30/).closest("details")).toBeNull();
  });

  it("shows a non-open route status as the state chip and the impairment reason in review notes", () => {
    const reason = "Active severe depeg of 8332 bps started 2026-03-22; static redemption route requires current live-open evidence before it can score.";
    render(<RedemptionBackstopCard entry={{
      ...BASE_ENTRY, score: null, resolutionState: "impaired", routeStatus: "degraded", routeStatusSource: "market-implied",
      routeStatusReason: reason, routeStatusReviewedAt: "2026-04-14", modelConfidence: "low",
    }} />);
    const root = moduleRoot();
    expect(within(root).getAllByText("Not rated").length).toBeGreaterThan(0);
    const routeStatus = formatRedemptionRouteStatus("degraded").toLowerCase();
    expect(within(root).getByText((c) => c.toLowerCase() === routeStatus)).toBeTruthy();
    expect(within(root).getByText(reason).closest("details")).not.toBeNull();
  });
});

describe("RedemptionBackstopCard footer freshness", () => {
  const HOUR = 3_600_000;
  const generationMs = BASE_ENTRY.updatedAt * 1000;
  async function footerTime(freshness: Parameters<typeof RedemptionRouteSection>[0]["freshness"], ageMs: number) {
    vi.setSystemTime(new Date(generationMs + ageMs));
    const view = render(<RedemptionRouteSection entry={BASE_ENTRY} reportCard={null} coinId={BASE_ENTRY.stablecoinId} freshness={freshness} />);
    while (frames.length) await act(async () => { frames.shift()!(0); });
    await act(async () => { vi.advanceTimersByTime(0); });
    const time = view.container.querySelector("time[data-state]")!;
    return { time, state: time.getAttribute("data-state"), label: time.querySelector(".sr-only")?.textContent ?? "", unmount: view.unmount };
  }
  const lane = (meta?: Record<string, unknown> | null, error: unknown = null) => ({ dataUpdatedAt: generationMs, error, hasData: true, meta: meta as never });

  it("stays neutral through 4d and warns only past the shared public band", async () => {
    const at16h = await footerTime(lane(), 16 * HOUR);
    expect(at16h.state).toBe("current");
    expect(at16h.label).toMatch(/Stale when more than 4d old$/);
    at16h.unmount();
    const at96h = await footerTime(lane(), 96 * HOUR);
    expect(at96h.state).toBe("retained");
    at96h.unmount();
    expect((await footerTime(lane(), 96 * HOUR + 1)).state).toBe("stale");
  });

  it("honors a producer budget, a server stale floor, retained refresh failure and null authority", async () => {
    const meta = { updatedAt: BASE_ENTRY.updatedAt, ageSeconds: 0, status: "fresh", freshBudgetSec: 86_400, degradedBudgetSec: 2 * 86_400 };
    const budgeted = await footerTime(lane(meta), 3 * 86_400_000);
    expect(budgeted.state).toBe("stale");
    expect(budgeted.label).toMatch(/Stale when more than 2d old$/);
    budgeted.unmount();
    const floor = await footerTime(lane({ ...meta, status: "stale" }), HOUR);
    expect(floor.state).toBe("stale");
    floor.unmount();
    const failed = await footerTime(lane(null, new Error("refetch failed")), HOUR);
    expect(failed.state).toBe("retained");
    failed.unmount();
    const unknown = await footerTime(lane({ updatedAt: null, ageSeconds: null, status: "unknown" }), HOUR);
    expect(unknown.state).toBe("unavailable");
    expect(unknown.time.getAttribute("datetime")).toBeNull();
  });

  it("shows the served generation rather than the per-coin row clock", async () => {
    const generation = BASE_ENTRY.updatedAt + 600;
    const { time } = await footerTime(lane({ updatedAt: generation, ageSeconds: 0, status: "fresh" }), 1_200_000);
    expect(time.getAttribute("datetime")).toBe(new Date(generation * 1000).toISOString());
  });
});

describe("RedemptionRouteSection without a scored route", () => {
  const disposition = REVIEWED_REDEMPTION_COVERAGE_DISPOSITIONS.find(
    (row) => NO_HOLDER_REASON_CODES.includes(row.reasonCode) && row.evidenceUrls.length > 0,
  );

  it("renders the reviewed no-holder disposition as a strip with its reason, Exit's best route and folded notes", () => {
    if (!disposition) throw new Error("no reviewed no-holder disposition with evidence");
    const card = makeV9Card();
    const primary = card.breakdowns?.exit.primaryRoute;
    if (!primary || primary.score === null) throw new Error("fixture lacks a scored Exit primary route");

    render(<RedemptionRouteSection entry={null} reportCard={card} coinId={disposition.id} />);
    const root = moduleRoot();
    expect(root.getAttribute("data-evidence-module")).toBe("strip");
    expect(root.querySelector("h3")).not.toBeNull();
    const group = within(root).getByRole("group", { name: "Where the Exit pillar looks instead" });
    expect(group.closest("details")).toBeNull();
    expect(group.textContent).toContain(`Exit's best route${Math.round(primary.score)}`);
    expect(usageCells(card, null)).toEqual({ best: expect.objectContaining({ figure: Math.round(primary.score) }) });
    expect(within(root).getByText(disposition.blocker).closest("details")?.open).toBe(false);
    expect(within(root).getAllByText((content) => content.includes(disposition.reviewedDate)).some((stamp) => stamp.closest("details") === null)).toBe(true);
    expect(root.querySelectorAll("summary")).toHaveLength(1);
    expect(root.querySelector("time[data-state]")).toBeNull();
  });
});
