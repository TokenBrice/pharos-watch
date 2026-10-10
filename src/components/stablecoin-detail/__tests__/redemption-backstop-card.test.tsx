// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { render, within } from "@testing-library/react";
import { RedemptionRouteSection } from "../redemption-backstop-card";
import { buildRedemptionBackstopCardViewModel } from "../redemption-backstop-card-view-model";
import { formatRedemptionDocsProvenance, formatRedemptionRouteStatus } from "@shared/lib/classification";
import { makeV9Card } from "@/test/fixtures/safety-score-v9";
import { REVIEWED_REDEMPTION_COVERAGE_DISPOSITIONS } from "@shared/data/coverage-dispositions/redemption-coverage-dispositions";
import type { RedemptionBackstopEntry, SafetyScoreV9CurrentCard } from "@shared/types";
import { composeExitComponentScore } from "@shared/lib/exit-route-scoring";
import { REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS } from "@shared/lib/redemption-backstop-scoring";

function RedemptionBackstopCard({ entry }: { entry: RedemptionBackstopEntry }) {
  return <RedemptionRouteSection entry={entry} reportCard={null} coinId={entry.stablecoinId} />;
}

const BASE_ENTRY: RedemptionBackstopEntry = {
  stablecoinId: "eurc-circle",
  score: 65,
  dexLiquidityScore: 44,
  accessScore: 40,
  settlementScore: 65,
  executionCertaintyScore: 60,
  capacityScore: 100,
  outputAssetQualityScore: 100,
  costScore: 40,
  routeFamily: "offchain-issuer",
  accessModel: "issuer-api",
  settlementModel: "same-day",
  executionModel: "rules-based-nav",
  outputAssetType: "stable-single",
  provider: "supply-full-model",
  sourceMode: "estimated",
  resolutionState: "resolved",
  routeStatus: "open",
  routeStatusSource: "static-config",
  holderEligibility: "verified-customer",
  capacityConfidence: "heuristic",
  capacitySemantics: "eventual-only",
  feeConfidence: "undisclosed-reviewed",
  feeModelKind: "undisclosed-reviewed",
  modelConfidence: "low",
  immediateCapacityUsd: null,
  immediateCapacityRatio: null,
  feeBps: null,
  feeDescription: undefined,
  queueEnabled: false,
  methodologyVersion: "1.1",
  updatedAt: 1_700_000_000,
  capsApplied: [],
};

const DOCS: NonNullable<RedemptionBackstopEntry["docs"]> = {
  label: "Reserve feed",
  url: "https://example.com/reserves",
  reviewedAt: "2026-03-30",
  provenance: "proof-of-reserves",
  sources: [{ label: "Reserve feed", url: "https://example.com/reserves", supports: ["capacity"] }],
};

const NO_HOLDER_REASON_CODES: readonly string[] = [
  "pegkeeper-only",
  "no-holder-route",
  "borrower-repay-only",
  "secondary-market-only",
];

function precedes(first: Node, second: Node): boolean {
  return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

function moduleRoot(): HTMLElement {
  const root = document.getElementById("redemption");
  if (!root) throw new Error("no #redemption module");
  return root;
}

/** The one match on the summary layer; the folds may restate the same text. */
function onSummaryLayer(matches: readonly HTMLElement[]): HTMLElement {
  const visible = matches.filter((element) => element.closest("details") === null);
  expect(visible).toHaveLength(1);
  return visible[0]!;
}

// The footer's live-data freshness label is relative to the clock. Pinned five
// minutes after BASE_ENTRY.updatedAt, so it never reads an hour count that
// collides with the score digits the summary-layer matchers look for.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date((BASE_ENTRY.updatedAt + 300) * 1000));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("RedemptionBackstopCard", () => {
  it("uses the shared composition total and preserves component contribution order", () => {
    render(<RedemptionBackstopCard entry={BASE_ENTRY} />);
    const table = within(moduleRoot()).getByRole("table", { hidden: true });
    const rows = within(table).getAllByRole("row", { hidden: true });
    expect(rows.slice(1, 7).map((row) => row.querySelector("th")?.textContent)).toEqual([
      "Access", "Settlement", "Execution certainty", "Capacity", "Output quality", "Cost",
    ]);
    const total = composeExitComponentScore({
      access: BASE_ENTRY.accessScore!,
      settlement: BASE_ENTRY.settlementScore!,
      executionCertainty: BASE_ENTRY.executionCertaintyScore!,
      capacity: BASE_ENTRY.capacityScore!,
      outputAssetQuality: BASE_ENTRY.outputAssetQualityScore!,
      cost: BASE_ENTRY.costScore!,
    }, REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS);
    expect(rows[7]?.querySelector("td")?.textContent).toBe(total.toFixed(1));
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
      ...primary, routeId: `redemption:${entry.stablecoinId}:${entry.routeFamily}`, lane: "redemption",
      score: total, supportedComponentCeiling: total, confidenceFactor: 1, eligibilityMultiplier: 1,
      components: primary.components.map((component) => ({ ...component, score: 100 })),
      capsApplied: [],
    };
    render(<RedemptionRouteSection entry={entry} reportCard={card} coinId={entry.stablecoinId} />);
    const line = within(moduleRoot()).getByText(
      (content, element) => element?.tagName === "SPAN" && content.includes(`as ${Math.round(total)}, not 65`),
    );
    expect(line.textContent).toContain("standalone score carries");
  });

  it.each(["old", "new"])("reconciles exact route identity across opaque generation %s", (generation) => {
    const card = makeV9Card();
    card.breakdowns!.exit.primaryRoute = {
      ...card.breakdowns!.exit.primaryRoute!,
      key: `opaque:${generation}`,
      routeId: `redemption:${BASE_ENTRY.stablecoinId}:${BASE_ENTRY.routeFamily}`,
      lane: "redemption", score: BASE_ENTRY.score,
    };
    render(<RedemptionRouteSection entry={BASE_ENTRY} reportCard={card} coinId={BASE_ENTRY.stablecoinId} />);
    expect(within(moduleRoot()).getByText(/counts this route at the same score/)).toBeTruthy();
  });

  it.each([
    { name: "suffix collision", routeId: `redemption:other:${BASE_ENTRY.stablecoinId}:${BASE_ENTRY.routeFamily}`, lane: "redemption" },
    { name: "composed route", routeId: `composed:redemption:${BASE_ENTRY.stablecoinId}:${BASE_ENTRY.routeFamily}`, lane: "redemption" },
    { name: "specialized route", routeId: `redemption:${BASE_ENTRY.stablecoinId}:${BASE_ENTRY.routeFamily}:specialized`, lane: "redemption" },
    { name: "different lane", routeId: `redemption:${BASE_ENTRY.stablecoinId}:${BASE_ENTRY.routeFamily}`, lane: "dex" },
    { name: "missing identity", routeId: undefined, lane: undefined },
  ] as const)("never guesses this route from an opaque key with $name", ({ routeId, lane }) => {
    const card = makeV9Card();
    const exit = card.breakdowns!.exit;
    // Deliberately model an old/unadmitted response for the defensive consumer boundary.
    exit.primaryRoute = {
      ...exit.primaryRoute!, key: `redemption:gen:redemption:${BASE_ENTRY.stablecoinId}:${BASE_ENTRY.routeFamily}`,
      routeId, lane, score: BASE_ENTRY.score,
    } as unknown as NonNullable<typeof exit.primaryRoute>;
    exit.alternatives = [{
      key: exit.primaryRoute.key, routeId, lane, label: "Unrelated route", routeFamily: "issuer-redemption",
      score: 37, included: true, exclusionReason: null, confidenceDimensions: null,
      capacityEvidenceTier: "documented", rawSameNotionalCostBps: null, capacity: null,
    }] as unknown as typeof exit.alternatives;
    render(<RedemptionRouteSection entry={BASE_ENTRY} reportCard={card} coinId={BASE_ENTRY.stablecoinId} />);
    expect(within(moduleRoot()).queryByText(/counts this route|scores this route at/)).toBeNull();
    expect(within(moduleRoot()).getByText(/Exit pillar selects/)).toBeTruthy();
    exit.primaryRoute.score = null;
    const noQualifiedRoute = renderToStaticMarkup(
      <RedemptionRouteSection entry={BASE_ENTRY} reportCard={card} coinId={BASE_ENTRY.stablecoinId} />,
    );
    expect(noQualifiedRoute).toContain("is not in the Exit evaluation");
    expect(noQualifiedRoute).not.toContain("Exit cannot score it");
    expect(noQualifiedRoute).not.toContain("37 in Exit");
  });

  it("presents one standalone route score without the legacy effective exit score", () => {
    const html = renderToStaticMarkup(<RedemptionBackstopCard entry={BASE_ENTRY} />);

    expect(html).toContain("Issuer redemption route");
    expect(html).toContain("Standalone route score");
    expect(html).toContain("65/100");
    expect(html).not.toContain("58/100");
  });

  it("orders the summary visual → verdict → chips → disclosures, folds in the fixed order", () => {
    render(<RedemptionBackstopCard entry={{ ...BASE_ENTRY, docs: DOCS }} />);
    const root = moduleRoot();
    const viewModel = buildRedemptionBackstopCardViewModel(BASE_ENTRY);

    expect(root.tagName).toBe("SECTION");
    expect(root.querySelector("h3")).not.toBeNull();

    const visuals = within(root).getAllByRole("img");
    const verdict = within(root).getByText(
      (_, element) => element?.tagName === "P" && (element.textContent ?? "").includes(viewModel.accessLabel),
    );
    const confidenceChip = onSummaryLayer(within(root).getAllByText(viewModel.modelConfidenceLabel));
    const summaries = Array.from(root.querySelectorAll("summary"));

    for (const visual of visuals) expect(precedes(visual, verdict)).toBe(true);
    expect(precedes(verdict, confidenceChip)).toBe(true);
    expect(summaries.length).toBe(3);
    expect(precedes(confidenceChip, summaries[0]!)).toBe(true);

    const labels = summaries.map((summary) => summary.textContent ?? "");
    expect(labels[0]).toMatch(/Scoring breakdown/);
    expect(labels[1]).toMatch(/Capacity/);
    expect(labels[2]).toMatch(/Sources/);
  });

  it("names the holder station once on the drawn rail", () => {
    render(<RedemptionBackstopCard entry={BASE_ENTRY} />);

    const rail = within(moduleRoot()).getByRole("img", { name: /holders exit/i });
    expect(rail.textContent?.match(/Holder/g)).toHaveLength(1);
  });

  it("keeps the Exit pillar reconciliation as a muted line after the verdict", () => {
    const card = makeV9Card();
    const primary = card.breakdowns?.exit.primaryRoute;
    if (!primary || primary.score === null) throw new Error("fixture lacks a scored Exit primary route");
    render(<RedemptionRouteSection entry={BASE_ENTRY} reportCard={card} coinId={BASE_ENTRY.stablecoinId} />);

    const routeScore = String(Math.round(primary.score));
    const reconciliation = within(moduleRoot()).getByText(
      (content, element) => element?.tagName === "SPAN" && content.includes(routeScore) && content.includes("65"),
    );
    expect(reconciliation.closest("p")).not.toBeNull();
    expect(reconciliation.closest("details")).toBeNull();
    expect((reconciliation.textContent ?? "").trim().split(/\s+/).length).toBeLessThanOrEqual(25);
  });

  it("reconciles a different Exit score for the same route in place, naming the published cause", () => {
    // Exit re-scores the same six components; only its confidence factor differs.
    const standalone: Record<string, number | null> = {
      access: BASE_ENTRY.accessScore,
      settlement: BASE_ENTRY.settlementScore,
      executionCertainty: BASE_ENTRY.executionCertaintyScore,
      capacity: BASE_ENTRY.capacityScore,
      outputAssetQuality: BASE_ENTRY.outputAssetQualityScore,
      cost: BASE_ENTRY.costScore,
    };
    const card = makeV9Card();
    const exit = card.breakdowns?.exit;
    if (!exit?.primaryRoute) throw new Error("fixture lacks an Exit primary route");
    exit.primaryRoute = {
      ...exit.primaryRoute,
      key: `redemption:gen-1:redemption:${BASE_ENTRY.stablecoinId}:${BASE_ENTRY.routeFamily}`,
      routeId: `redemption:${BASE_ENTRY.stablecoinId}:${BASE_ENTRY.routeFamily}`,
      lane: "redemption",
      score: 58,
      supportedComponentCeiling: 64,
      confidenceFactor: 0.9,
      eligibilityMultiplier: 1,
      capsApplied: [],
      components: exit.primaryRoute.components.map((component) => ({
        ...component,
        score: standalone[component.key] ?? component.score,
      })),
    };
    render(<RedemptionRouteSection entry={BASE_ENTRY} reportCard={card} coinId={BASE_ENTRY.stablecoinId} />);

    const line = within(moduleRoot()).getByText(
      (content, element) => element?.tagName === "SPAN" && content.includes("58") && content.includes("65"),
    );
    expect(line.textContent).toMatch(/0\.9/);
    expect((line.textContent ?? "").trim().split(/\s+/).length).toBeLessThanOrEqual(25);
  });

  it("explains why no route qualifies when the Exit pillar credits none, with the pillar score", () => {
    const card = makeV9Card();
    const exit = card.breakdowns?.exit;
    if (!exit) throw new Error("fixture lacks an Exit breakdown");
    const pillarScore = card.pillars.exit.score;
    if (pillarScore === null) throw new Error("fixture lacks an Exit pillar score");
    exit.primaryRoute = null;
    exit.alternatives = [{
      key: `redemption:gen-1:redemption:${BASE_ENTRY.stablecoinId}:${BASE_ENTRY.routeFamily}`,
      routeId: `redemption:${BASE_ENTRY.stablecoinId}:${BASE_ENTRY.routeFamily}`,
      lane: "redemption",
      label: "Issuer redemption",
      routeFamily: "issuer-redemption",
      score: null,
      included: false,
      exclusionReason: "unsupported-same-notional-route",
      confidenceDimensions: null,
      capacityEvidenceTier: "unknown",
      rawSameNotionalCostBps: null,
      capacity: null,
    }];
    render(<RedemptionRouteSection entry={BASE_ENTRY} reportCard={card} coinId={BASE_ENTRY.stablecoinId} />);

    const line = within(moduleRoot()).getByText(
      (content, element) =>
        element?.tagName === "SPAN" && content.includes("65") && content.includes(String(Math.round(pillarScore))),
    );
    expect(line.closest("details")).toBeNull();
    expect((line.textContent ?? "").trim().split(/\s+/).length).toBeLessThanOrEqual(25);
  });

  describe("an unrated route the Exit pillar still scores", () => {
    // Resolved with eventual capacity only: the producer publishes no standalone score.
    const unrated: RedemptionBackstopEntry = { ...BASE_ENTRY, score: null, capacityScore: null };
    const ownKey = `redemption:gen-1:redemption:${BASE_ENTRY.stablecoinId}:${BASE_ENTRY.routeFamily}`;
    const EXIT_SCORE = 37;
    type Tier = "documented" | "live-direct";

    function asAlternative(card: SafetyScoreV9CurrentCard, tier: Tier) {
      card.breakdowns!.exit.alternatives = [{
        key: ownKey,
        routeId: `redemption:${BASE_ENTRY.stablecoinId}:${BASE_ENTRY.routeFamily}`,
        lane: "redemption",
        label: "Issuer redemption",
        routeFamily: "issuer-redemption",
        score: EXIT_SCORE,
        included: true,
        exclusionReason: null,
        confidenceDimensions: null,
        capacityEvidenceTier: tier,
        rawSameNotionalCostBps: null,
        capacity: null,
      }];
    }

    function asPrimary(card: SafetyScoreV9CurrentCard, tier: Tier) {
      const exit = card.breakdowns!.exit;
      exit.primaryRoute = {
        ...exit.primaryRoute!, key: ownKey, score: EXIT_SCORE, capacityEvidenceTier: tier,
        routeId: `redemption:${BASE_ENTRY.stablecoinId}:${BASE_ENTRY.routeFamily}`, lane: "redemption",
      };
    }

    /** The summary-layer verdict and the reconciliation line naming Exit's score. */
    function renderSummary(place: typeof asAlternative, tier: Tier, entry = unrated) {
      const card = makeV9Card();
      if (!card.breakdowns?.exit.primaryRoute) throw new Error("fixture lacks an Exit primary route");
      place(card, tier);
      const { unmount } = render(<RedemptionRouteSection entry={entry} reportCard={card} coinId={entry.stablecoinId} />);
      const root = moduleRoot();
      const line = within(root).getByText(
        (content, element) =>
          element?.tagName === "SPAN" && element.closest("details") === null && content.includes(String(EXIT_SCORE)),
      );
      const reconciliation = line.textContent ?? "";
      const verdict = (line.closest("p")?.textContent ?? "").replace(reconciliation, "").trim();
      const pills = within(root).queryAllByText(buildRedemptionBackstopCardViewModel(entry).heroScoreLabel).length;
      unmount();
      return { verdict, reconciliation, pills };
    }

    it.each([
      ["Exit selects another route", asAlternative],
      ["Exit selects this route", asPrimary],
    ])("keeps the NR pill and names Exit's own score with the evidence it read when %s", (_, place) => {
      const documented = renderSummary(place, "documented");
      const live = renderSummary(place, "live-direct");

      expect(documented.pills).toBeGreaterThan(0);
      expect(documented.verdict).not.toContain(String(EXIT_SCORE));
      // The Exit number is explained by its evidence, so the line follows the published tier.
      expect(documented.reconciliation).not.toBe(live.reconciliation);
      expect(documented.reconciliation.trim().split(/\s+/).length).toBeLessThanOrEqual(25);
    });

    it("names why the standalone score is missing, per cause", () => {
      const eventualOnly = renderSummary(asAlternative, "documented");
      const unmeasured = renderSummary(asAlternative, "documented", { ...unrated, resolutionState: "missing-capacity" });

      expect(eventualOnly.verdict).not.toBe("");
      expect(eventualOnly.verdict).not.toBe(unmeasured.verdict);
    });
  });

  it("keeps one footer line without a score-inputs control; the inputs live in the Scoring breakdown fold", () => {
    render(<RedemptionBackstopCard entry={{ ...BASE_ENTRY, capsApplied: ["offchain-route-cap"] }} />);
    const root = moduleRoot();

    expect(within(root).queryByRole("button", { name: /score inputs/i })).toBeNull();
    const breakdown = Array.from(root.querySelectorAll("details")).find((fold) =>
      /Scoring breakdown/.test(fold.querySelector("summary")?.textContent ?? ""),
    );
    expect(breakdown).toBeDefined();
    const table = within(breakdown!).getByRole("table", { hidden: true });
    expect(within(table).getAllByRole("row", { hidden: true }).length).toBeGreaterThanOrEqual(8);
    expect(breakdown!.textContent).toMatch(/route score =/i);
    expect(breakdown!.textContent).toMatch(/Caps applied/);
  });

  it("renders explicit fixed-fee copy when fee bps are available", () => {
    const html = renderToStaticMarkup(
      <RedemptionBackstopCard
        entry={{
          ...BASE_ENTRY,
          stablecoinId: "avusd-avant",
          routeFamily: "queue-redeem",
          settlementModel: "days",
          feeBps: 5,
          feeDescription: "Protocol docs list a 5 bps redemption fee",
          costScore: 100,
        }}
      />,
    );

    expect(html).toContain("Redemption Fee");
    expect(html).toContain("5 bps (0.05%)");
  });

  it("renders documented variable fee logic when the route is not a single fixed bps value", () => {
    const html = renderToStaticMarkup(
      <RedemptionBackstopCard
        entry={{
          ...BASE_ENTRY,
          stablecoinId: "bold-liquity",
          routeFamily: "collateral-redeem",
          settlementModel: "atomic",
          feeModelKind: "formula",
          feeDescription: "Minimum 50 bps + baseRate (decays over time).",
        }}
      />,
    );

    expect(html).toContain("Redemption Fee");
    expect(html).toContain("Minimum 50 bps + baseRate");
    expect(html).toContain("publish a fee formula");
  });

  it("renders an explicit unknown-fee fallback when no fixed fee is modeled", () => {
    const html = renderToStaticMarkup(<RedemptionBackstopCard entry={BASE_ENTRY} />);

    expect(html).toContain("Redemption Fee");
    expect(html).toContain("Reviewed, but not published");
    expect(html).toContain("do not publish a bounded numeric redemption fee");
  });

  it("renders unquantified eventual-only capacity without implying current-supply coverage", () => {
    const html = renderToStaticMarkup(<RedemptionBackstopCard entry={BASE_ENTRY} />);

    expect(html).toContain("Eventual Redeemability");
    expect(html).toContain("Not separately quantified");
    expect(html).toContain("Eventual route capacity is unquantified");
    expect(html).toContain("no current-supply coverage or immediate cash buffer is asserted");
    expect(html).not.toContain("eventual redeemability of current supply");
  });

  it("renders supply-wide eventual redeemability only with an admitted bound", () => {
    const html = renderToStaticMarkup(
      <RedemptionBackstopCard entry={{
        ...BASE_ENTRY,
        capacityConfidence: "documented-bound",
        capacityProfile: {
          eventualUsd: 30_000_000,
          scoringUsd: 30_000_000,
          scoringHorizon: "eventual",
          capacityProfileConfidence: "documented-bound",
        },
      }} />,
    );

    expect(html).toContain("Eventual Redeemability");
    expect(html).toContain("$30.0M");
    expect(html).toContain("eventual redeemability of current supply");
    expect(html).toContain("not as an immediate cash buffer");
    expect(html).not.toContain("Eventual route capacity is unquantified");
  });

  it("renders v4 capacity horizon, exit correlation, cost scenarios, and confidence detail", () => {
    const html = renderToStaticMarkup(
      <RedemptionBackstopCard
        entry={{
          ...BASE_ENTRY,
          capacitySemantics: "immediate-bounded",
          capacityConfidence: "live-direct",
          immediateCapacityUsd: 4_000_000,
          immediateCapacityRatio: 0.08,
          routeExitCorrelation: "independent-issuer-rail",
          eventualRedeemabilityScore: 82,
          capacityProfile: {
            immediateUsd: 4_000_000,
            dailyLimitUsd: 1_500_000,
            queuedUsd: 12_000_000,
            eventualUsd: 20_000_000,
            scoringUsd: 1_500_000,
            scoringHorizon: "daily",
            capacityProfileConfidence: "live-direct",
            modeledExitSizeUsd: 2_000_000,
          },
          costScenarioScores: {
            retail: 40,
            activeUser: 80,
            institutional: 100,
          },
          confidenceDetails: {
            capacityEvidenceQuality: 90,
            feeEvidenceQuality: 70,
            routeStatusFreshness: 80,
            holderCohortBreadth: 60,
            sourceQuality: 95,
            reviewedDocAgeDays: 12,
            reasons: ["live telemetry reviewed"],
          },
        }}
      />,
    );

    expect(html).toContain("Daily Capacity");
    expect(html).toContain("$1.5M");
    expect(html).toContain("Current modeled capacity is daily-limited");
    expect(html).toMatch(/Exit correlation:\s*<span[^>]*>independent issuer rail</);
    expect(html).toContain("Scoring capacity: $1.5M");
    expect(html).toContain("Eventual capacity: $20.0M");
    expect(html).toContain("Queued capacity: $12.0M");
    expect(html).toContain("Modeled exit: $2.0M");
    expect(html).toContain("Eventual score: 82/100");
    // Retail and institutional cost are distinct scores; swapping them must fail.
    expect(html).toContain("Retail cost: 40/100");
    expect(html).toContain("Active-user cost: 80/100");
    expect(html).toContain("Institutional cost: 100/100");
    expect(html).toContain("Confidence Detail");
    expect(html).toContain("Capacity evidence: 90/100");
    expect(html).toContain("Fee evidence: 70/100");
    expect(html).toContain("Route freshness: 80/100");
    expect(html).toContain("Holder breadth: 60/100");
    expect(html).toContain("Source quality: 95/100");
    expect(html).toContain("Reviewed docs age: 12d");
    expect(html).toContain("live telemetry reviewed");
  });

  it("drops the score track for an unrated route and folds the resolution summary into review notes", () => {
    const unrated: RedemptionBackstopEntry = {
      ...BASE_ENTRY,
      score: null,
      sourceMode: "static",
      resolutionState: "missing-capacity",
      modelConfidence: "low",
    };
    const scoredImages = render(<RedemptionBackstopCard entry={BASE_ENTRY} />).container.querySelectorAll("[role='img']").length;
    const { container } = render(<RedemptionBackstopCard entry={unrated} />);
    const viewModel = buildRedemptionBackstopCardViewModel(unrated);

    expect(container.querySelectorAll("[role='img']").length).toBe(scoredImages - 1);
    // `MethodologyHint` draws its trigger once per breakpoint branch (sheet
    // below md, popover from md), one of them CSS-hidden, so the pill may
    // occur twice in the DOM.
    expect(within(container).getAllByText(viewModel.heroScoreLabel).length).toBeGreaterThan(0);
    expect(onSummaryLayer(within(container).getAllByText(viewModel.modelConfidenceLabel))).toBeTruthy();
    const resolutionState = viewModel.resolutionStateLabel.toLowerCase();
    expect(within(container).getByText((content) => content.toLowerCase() === resolutionState)).toBeTruthy();

    const summary = within(container).getByText(viewModel.resolutionSummary!);
    expect(summary.closest("details")?.querySelector("summary")?.textContent).toMatch(/Review notes/);
  });

  it("puts source citations and provenance inside the fold and the review date on the footer line", () => {
    render(<RedemptionBackstopCard entry={{ ...BASE_ENTRY, docs: DOCS }} />);
    const root = moduleRoot();

    const link = within(root).getByRole("link", { name: "Reserve feed", hidden: true });
    const fold = link.closest("details");
    expect(fold?.open).toBe(false);
    expect(fold?.contains(within(root).getByText(formatRedemptionDocsProvenance("proof-of-reserves")))).toBe(true);
    expect(within(root).getByText(/2026-03-30/).closest("details")).toBeNull();
  });

  it("shows a non-open route status as the state chip and the impairment reason in review notes", () => {
    const reason =
      "Active severe depeg of 8332 bps started 2026-03-22; static redemption route requires current live-open evidence before it can score.";
    render(
      <RedemptionBackstopCard
        entry={{
          ...BASE_ENTRY,
          score: null,
          resolutionState: "impaired",
          routeStatus: "degraded",
          routeStatusSource: "market-implied",
          routeStatusReason: reason,
          routeStatusReviewedAt: "2026-04-14",
          modelConfidence: "low",
        }}
      />,
    );
    const root = moduleRoot();

    // One pill per `MethodologyHint` breakpoint branch; see above.
    expect(within(root).getAllByText("NR").length).toBeGreaterThan(0);
    const routeStatus = formatRedemptionRouteStatus("degraded").toLowerCase();
    expect(within(root).getByText((content) => content.toLowerCase() === routeStatus)).toBeTruthy();
    expect(within(root).getByText(reason).closest("details")).not.toBeNull();
  });
});

describe("RedemptionRouteSection without a scored route", () => {
  const disposition = REVIEWED_REDEMPTION_COVERAGE_DISPOSITIONS.find(
    (row) => NO_HOLDER_REASON_CODES.includes(row.reasonCode) && row.evidenceUrls.length > 0,
  );

  it("renders the reviewed no-holder disposition as a strip with its reason, reconciliation and folded notes", () => {
    if (!disposition) throw new Error("no reviewed no-holder disposition with evidence");
    const card = makeV9Card();
    const primary = card.breakdowns?.exit.primaryRoute;
    if (!primary || primary.score === null) throw new Error("fixture lacks a scored Exit primary route");

    render(<RedemptionRouteSection entry={null} reportCard={card} coinId={disposition.id} />);
    const root = moduleRoot();

    expect(root.getAttribute("data-evidence-module")).toBe("strip");
    expect(root.querySelector("h3")).not.toBeNull();
    // Verdict and reconciliation share the always-visible summary paragraph.
    const routeScore = String(Math.round(primary.score));
    const summaryParagraphs = Array.from(root.querySelectorAll("p")).filter(
      (paragraph) => paragraph.closest("details") === null && (paragraph.textContent ?? "").includes(routeScore),
    );
    expect(summaryParagraphs).toHaveLength(1);

    const notes = within(root).getByText(disposition.blocker);
    expect(notes.closest("details")?.open).toBe(false);
    const stamps = within(root).getAllByText((content) => content.includes(disposition.reviewedDate));
    expect(stamps.some((stamp) => stamp.closest("details") === null)).toBe(true);
    expect(root.querySelectorAll("summary")).toHaveLength(1);
  });

  it("renders nothing for a coin with neither a route nor a no-holder disposition", () => {
    const { container } = render(
      <RedemptionRouteSection entry={null} reportCard={null} coinId="not-a-reviewed-coin" />,
    );

    expect(container.firstChild).toBeNull();
  });
});
