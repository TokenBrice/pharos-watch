// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SafetyScoreV9CurrentCardSchema } from "@shared/types/safety-score-v9-public";
import { StablecoinSafetyScoreV9Card } from "@/components/stablecoin-detail/stablecoin-safety-score-v9-card";

import { makeReportCardsV9Response, makeV9Card, makeV9Pillars } from "@/test/fixtures/safety-score-v9";

// The shared V9 card fixture derives its pillars from one default quality
// score; these suites assert on specific pillar values and on which pillar is
// weakest (the card auto-expands it), so they declare their pillars.
const EXIT_WEAKEST_PILLARS = makeV9Pillars({ backing: 88, exit: 84, control: 86 });

describe("StablecoinSafetyScoreV9Card", () => {
  it("shows a display-only provisional badge beside the grade with a keyboard-accessible explanation", async () => {
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    const card = makeV9Card({ provisional: true, unknownPricedWeightShare: 0.65 });
    const response = makeReportCardsV9Response();
    const { rerender } = render(
      <StablecoinSafetyScoreV9Card card={card} identity={response.safetyScoreIdentity} updatedAtMs={null} />,
    );
    const badge = screen.getByRole("button", { name: "Provisional Safety Score" });
    expect(badge.parentElement?.textContent).toContain(card.grade);
    fireEvent.focus(badge);
    expect((await screen.findByRole("tooltip")).textContent).toContain("65.0% of scoring weight is priced as unknown. This label does not change the score.");
    rerender(
      <StablecoinSafetyScoreV9Card card={makeV9Card()} identity={response.safetyScoreIdentity} updatedAtMs={null} />,
    );
    expect(screen.queryByRole("button", { name: "Provisional Safety Score" })).toBeNull();
  });


  it.each([
    { name: "links every pillar when the page does not say which boards render", anchors: undefined, linked: ["Backing", "Exit", "Economic Control"] },
    {
      name: "links only the pillars whose evidence board renders",
      anchors: { backing: "below-xl" as const, exit: "none" as const, control: "all" as const },
      linked: ["Backing", "Economic Control"],
    },
  ])("$name", ({ anchors, linked }) => {
    const card = makeV9Card({ score: 84, grade: "A", pillars: EXIT_WEAKEST_PILLARS });
    const response = makeReportCardsV9Response({ cards: [card] });

    const { container } = render(
      <StablecoinSafetyScoreV9Card
        card={card}
        identity={response.safetyScoreIdentity}
        updatedAtMs={response.updatedAt * 1000}
        evidenceAnchors={anchors}
      />,
    );

    const evidenceLinks = Array.from(container.querySelectorAll('a[href$="-evidence"]'), (link) => link.getAttribute("aria-label"));
    expect(evidenceLinks).toEqual(linked.map((label) => `${label} evidence`));
  });

  it("renders rated V9 data in one full-width card without a reserve column", () => {
    const bindingCap = {
      kind: "track-record",
      limit: 84,
      source: "track-record" as const,
      reason: "Less than two years of implementation history.",
      binding: true,
    };
    const card = makeV9Card({
      score: 84,
      grade: "A",
      pillars: EXIT_WEAKEST_PILLARS,
      bindingCap,
      caps: [bindingCap],
      accessPosture: {
        transfer: "permissionless",
        freezeExposure: "none-known",
        primaryExit: "permissionless",
        governance: "concentrated",
        unknownFields: [],
        signals: [],
        reasons: [],
      },
      dependencies: {
        serial: [{ upstreamAssetId: "usdc-circle", score: 84, ratingStatus: 84 === null ? "not-rated" as const : "rated" as const, partialEvidence: null, causeGapRefs: [], limitedEvidenceCauses: 84 === null ? ["U" as const] : [], blocked: false }],
        basket: [],
        cycleBlocked: false,
        reasonCodes: [],
      },
    });
    card.scoreTrace.stages.preCapScore = 86.9;
    const response = makeReportCardsV9Response({ cards: [card] });

    render(
      <StablecoinSafetyScoreV9Card
        card={card}
        identity={response.safetyScoreIdentity}
        updatedAtMs={response.updatedAt * 1000}
        stablecoinName="Test Stablecoin"
      />,
    );

    expect(screen.getAllByText("A").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/84/).length).toBeGreaterThan(0);
    expect(screen.queryByText("Pre-cap 86.9")).toBeNull();
    expect(screen.getByLabelText("How this score is built")).toBeTruthy();
    expect(screen.getByText("Backing")).toBeTruthy();
    expect(screen.getByText("Exit")).toBeTruthy();
    expect(screen.getByText("Economic Control")).toBeTruthy();
    expect(screen.getByText("Binding cap")).toBeTruthy();
    expect(screen.queryByText("Resilience")).toBeNull();
    expect(screen.queryByText("Decentralization")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Backing/ }));
    expect(screen.getAllByText("Backing components").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Reviewed reserves").length).toBeGreaterThan(0);
  });

  it("renders weighted component bars and control binding semantics from V9 breakdowns", () => {
    const card = makeV9Card({ pillars: EXIT_WEAKEST_PILLARS });
    card.breakdowns = {
      backing: { evaluatedScore: 86, publishedScore: 88, aggregationWeight: 0.4, aggregationDisposition: 'included' as const, causeGapRefs: [], limitedEvidenceCauses: [], groups: [{ key: "reserves", label: "Reserves", score: 86, effectiveScoringWeight: 1, cause: null, causeGapRefs: [], scoringDisposition: 'included' as const }],
      components: [{ key: "reserve:reserve:wsteth", label: "wstETH", source: "reserve-exposure", score: 86, effectiveScoringWeight: 1, wholeAssetWeight: 1, weightedContribution: 86, observationState: "known", cause: null, causeGapRefs: [], scoringDisposition: 'included' as const }],
      adjustments: [{
        kind: "operational-resilience-credit",
        scoreBefore: 86,
        scoreAfter: 88,
        delta: 2,
      }], },
      exit: { evaluatedScore: 84, publishedScore: 84, aggregationWeight: 0.35, aggregationDisposition: 'included' as const, causeGapRefs: [], limitedEvidenceCauses: [], stressRequest: {
        requestedNotionalUsd: 10_000_000,
        maxCostBps: 100,
        comparisonWindowSec: 86_400,
      },
      primaryRoute: { key: "redemption:primary", routeId: "primary", lane: "redemption", label: "Direct redemption", routeFamily: "issuer-redemption", score: 84, components: [
        { key: "access", label: "Access", score: 90, weight: 0.2, effectiveScoringWeight: 0.2, weightedContribution: 18, cause: null, causeGapRefs: [], scoringDisposition: 'included' as const },
        { key: "settlement", label: "Settlement", score: 84, weight: 0.15, effectiveScoringWeight: 0.15, weightedContribution: 12.6, cause: null, causeGapRefs: [], scoringDisposition: 'included' as const },
        { key: "executionCertainty", label: "Execution certainty", score: 80, weight: 0.15, effectiveScoringWeight: 0.15, weightedContribution: 12, cause: null, causeGapRefs: [], scoringDisposition: 'included' as const },
        { key: "capacity", label: "Capacity", score: 78, weight: 0.25, effectiveScoringWeight: 0.25, weightedContribution: 19.5, cause: null, causeGapRefs: [], scoringDisposition: 'included' as const },
        { key: "outputAssetQuality", label: "Output asset quality", score: 92, weight: 0.15, effectiveScoringWeight: 0.15, weightedContribution: 13.8, cause: null, causeGapRefs: [], scoringDisposition: 'included' as const },
        { key: "cost", label: "Cost", score: 81, weight: 0.1, effectiveScoringWeight: 0.1, weightedContribution: 8.1, cause: null, causeGapRefs: [], scoringDisposition: 'included' as const },
      ], confidenceFactor: 1, confidenceDimensions: { observation: {factor: 1, cause: null, causeGapRefs: []}, model: {factor: 1, cause: null, causeGapRefs: []}, capacityMethod: {factor: 1, cause: null, causeGapRefs: []} }, capacityEvidenceTier: 'live-direct' as const, rawSameNotionalCostBps: null, supportedComponentCeiling: [
        { key: "access", label: "Access", score: 90, weight: 0.2, effectiveScoringWeight: 0.2, weightedContribution: 18, cause: null, causeGapRefs: [], scoringDisposition: 'included' as const },
        { key: "settlement", label: "Settlement", score: 84, weight: 0.15, effectiveScoringWeight: 0.15, weightedContribution: 12.6, cause: null, causeGapRefs: [], scoringDisposition: 'included' as const },
        { key: "executionCertainty", label: "Execution certainty", score: 80, weight: 0.15, effectiveScoringWeight: 0.15, weightedContribution: 12, cause: null, causeGapRefs: [], scoringDisposition: 'included' as const },
        { key: "capacity", label: "Capacity", score: 78, weight: 0.25, effectiveScoringWeight: 0.25, weightedContribution: 19.5, cause: null, causeGapRefs: [], scoringDisposition: 'included' as const },
        { key: "outputAssetQuality", label: "Output asset quality", score: 92, weight: 0.15, effectiveScoringWeight: 0.15, weightedContribution: 13.8, cause: null, causeGapRefs: [], scoringDisposition: 'included' as const },
        { key: "cost", label: "Cost", score: 81, weight: 0.1, effectiveScoringWeight: 0.1, weightedContribution: 8.1, cause: null, causeGapRefs: [], scoringDisposition: 'included' as const },
      ].reduce((sum, component) => sum + component.weightedContribution, 0),
      capsApplied: [], },
      diversification: null,
      alternatives: [{ key: "dex:curve", routeId: "curve", lane: "dex", label: "Curve liquidity", routeFamily: "dex-amm", score: 77, included: true, exclusionReason: null, confidenceDimensions: null, capacityEvidenceTier: 'unknown' as const, rawSameNotionalCostBps: null, }],
      adjustments: [], },
      control: { evaluatedScore: 86, publishedScore: 86, aggregationWeight: 0.25, aggregationDisposition: 'included' as const, causeGapRefs: [], limitedEvidenceCauses: [], method: "minimum-binding-component",
      components: [
        { key: "mint", label: "Mint authority", kind: "mint", score: 86, binding: true, posture: "concentrated", effectiveScoringWeight: 1, cause: null, causeGapRefs: [], scoringDisposition: 'included' as const },
        { key: "oracle", label: "Oracle design", kind: "oracle", score: 95, binding: false, posture: "distributed", effectiveScoringWeight: 0, cause: null, causeGapRefs: [], scoringDisposition: 'included' as const },
      ],
      adjustments: [], },
    };
    const validatedCard = SafetyScoreV9CurrentCardSchema.parse(card);
    const response = makeReportCardsV9Response({ cards: [validatedCard] });

    render(
      <StablecoinSafetyScoreV9Card
        card={validatedCard}
        identity={response.safetyScoreIdentity}
        updatedAtMs={response.updatedAt * 1000}
      />,
    );

    // Pillars start folded on every viewport; open Exit to inspect its route
    // breakdown before asserting the selected-route details.
    fireEvent.click(screen.getByRole("button", { name: /Exit/ }));
    expect(screen.getByText("Primary route components — Direct redemption")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Backing/ }));
    expect(screen.getByText("Backing components")).toBeTruthy();
    expect(screen.getByText("Evaluator to published")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Economic Control/ }));
    expect(screen.getByText("Control inputs")).toBeTruthy();
    // Roles use the shared Control role grammar, never local "Binding" copy.
    expect(screen.getByText("Limiting")).toBeTruthy();
    expect(screen.getByText("Diagnostic")).toBeTruthy();
    expect(screen.queryByText("Binding")).toBeNull();
    expect(screen.queryByText("Scored inputs")).toBeNull();
  });

  it("shows a positive sub-one component score instead of rounding it to zero", () => {
    const card = makeV9Card({ pillars: EXIT_WEAKEST_PILLARS });
    const capacity = card.breakdowns?.exit.primaryRoute?.components.find(
      (component) => component.key === "capacity",
    );
    if (capacity === undefined) throw new Error("fixture lacks an Exit capacity component");
    capacity.score = 0.13;

    const response = makeReportCardsV9Response({ cards: [card] });
    render(
      <StablecoinSafetyScoreV9Card
        card={card}
        identity={response.safetyScoreIdentity}
        updatedAtMs={response.updatedAt * 1000}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Exit/ }));
    expect(screen.getByRole("img", {
      name: /Capacity score.*<1 out of 100/,
    })).toBeTruthy();
  });

  it("shows no held-publication chip; held state belongs to /status", () => {
    const card = makeV9Card();
    const response = makeReportCardsV9Response({
      cards: [card],
      publicationHealth: {
        schemaVersion: 2,
        status: "held",
        acceptedPublicationGenerationId: "v9-publication-1",
        acceptedAtSec: 1_752_534_000,
        attemptedAtSec: 1_752_534_120,
        heldSinceSec: 1_752_534_060,
        reasons: [{ code: "dex-stale" }],
      },
    });

    render(
      <StablecoinSafetyScoreV9Card
        card={card}
        identity={response.safetyScoreIdentity}
        updatedAtMs={response.updatedAt * 1000}
      />,
    );

    expect(screen.queryByRole("button", { name: /Ratings held/ })).toBeNull();
    expect(document.body.textContent).not.toContain("dex-stale");
  });

  it("shows no partial-evidence ops chip in the card header", () => {
    const card = makeV9Card({ localCauseGaps: ["transparency"], partialEvidence: {
      reasonCode: "partial-evidence-pipeline-gap", excludedPillars: [],
      excludedComponentKeys: ["reserve:reviewed:transparency"], causeGapRefs: [0], causes: ["B"],
    } });
    const response = makeReportCardsV9Response({ cards: [card] });

    render(
      <StablecoinSafetyScoreV9Card card={card} identity={response.safetyScoreIdentity} updatedAtMs={response.updatedAt * 1000} />,
    );

    expect(screen.queryByRole("button", { name: /Partial evidence/ })).toBeNull();
  });

  it("renders an NR result without manufacturing score stages", () => {
    const card = makeV9Card({
      score: null,
      grade: "NR",
      qualityScore: null,
      pegMultiplier: null,
      pegAdjustedScore: null,
      nrReasons: [{
        code: "missing-pillar",
        message: "Required pillar evidence is missing.",
        field: "backing",
        origin: "asset",
      }],
    });
    const response = makeReportCardsV9Response({ cards: [card] });

    render(
      <StablecoinSafetyScoreV9Card
        card={card}
        identity={response.safetyScoreIdentity}
        updatedAtMs={null}
      />,
    );

    expect(screen.getByText("Not rated")).toBeTruthy();
    expect(screen.getByText("Required pillar evidence is missing.")).toBeTruthy();
    expect(screen.queryByText(/Pre-cap/)).toBeNull();
  });
});
