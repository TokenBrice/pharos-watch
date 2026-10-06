// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SafetyScoreV9CurrentCardSchema } from "@shared/types/safety-score-v9-public";
import { StablecoinSafetyScoreV9Card } from "@/components/stablecoin-detail/stablecoin-safety-score-v9-card";
import { makeReportCardsV9Response, makeV9Card, makeV9Pillars } from "@/test/fixtures/safety-score-v9";

// The shared V9 card fixture derives its pillars from one default quality
// score; these suites assert on specific pillar values and on which pillar is
// weakest (the card auto-expands it), so they declare their pillars.
const EXIT_WEAKEST_PILLARS = makeV9Pillars({ backing: 88, exit: 84, control: 86 });

describe("StablecoinSafetyScoreV9Card", () => {

  it("names its subject in the header so a screenshot of the module stands alone", () => {
    const card = makeV9Card({ score: 84, grade: "A", pillars: EXIT_WEAKEST_PILLARS });
    const response = makeReportCardsV9Response({ cards: [card] });

    const { container } = render(
      <StablecoinSafetyScoreV9Card
        card={card}
        identity={response.safetyScoreIdentity}
        publicationHealth={response.publicationHealth}
        updatedAtMs={response.updatedAt * 1000}
        stablecoinName="Test Stablecoin"
        stablecoinSymbol="TUSD"
        logoSrc="/logos/test-usd.png"
      />,
    );

    expect(screen.getByRole("heading", { name: "Safety Score" })).toBeTruthy();
    expect(screen.getByText("TUSD")).toBeTruthy();
    expect(container.querySelector('img[alt="TUSD logo"]')).not.toBeNull();
  });

  it("keeps the header title alone when no coin identity is supplied", () => {
    const card = makeV9Card({ score: 84, grade: "A", pillars: EXIT_WEAKEST_PILLARS });
    const response = makeReportCardsV9Response({ cards: [card] });

    render(
      <StablecoinSafetyScoreV9Card
        card={card}
        identity={response.safetyScoreIdentity}
        publicationHealth={response.publicationHealth}
        updatedAtMs={response.updatedAt * 1000}
      />,
    );

    expect(screen.getByRole("heading", { name: "Safety Score" })).toBeTruthy();
    expect(screen.queryByText("TUSD")).toBeNull();
  });

  it("renders rated V9 data in one full-width card without a reserve column", () => {
    const bindingCap = {
      kind: "track-record",
      limit: 84,
      source: "structural" as const,
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
        publicationHealth={response.publicationHealth}
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
      primaryRoute: { key: "redemption:primary", label: "Direct redemption", routeFamily: "issuer-redemption", score: 84, components: [
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
      ].reduce((sum, component) => sum + component.weightedContribution, 0), eligibilityMultiplier: 1,
      capsApplied: [], },
      diversification: null,
      alternatives: [{ key: "dex:curve", label: "Curve liquidity", routeFamily: "dex-amm", score: 77, included: true, exclusionReason: null, confidenceDimensions: null, capacityEvidenceTier: 'unknown' as const, rawSameNotionalCostBps: null,  }],
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
        publicationHealth={response.publicationHealth}
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
    expect(screen.getByText("Control components")).toBeTruthy();
    expect(screen.getByText("Binding")).toBeTruthy();
    expect(screen.getByText("Diagnostic")).toBeTruthy();
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
        publicationHealth={response.publicationHealth}
        updatedAtMs={response.updatedAt * 1000}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Exit/ }));
    expect(screen.getByRole("img", {
      name: /Capacity score.*<1 out of 100/,
    })).toBeTruthy();
  });

  it("shows held publication as a header chip; reason codes stay machine-readable, never copy", () => {
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
        publicationHealth={response.publicationHealth}
        updatedAtMs={response.updatedAt * 1000}
      />,
    );

    const chip = screen.getByRole("button", { name: /Ratings held/ });
    expect(chip.getAttribute("data-reason-codes")).toBe("dex-stale");
    fireEvent.click(chip);
    const time = document.querySelector("time");
    expect(time?.getAttribute("datetime")).toBe(new Date(1_752_534_060 * 1000).toISOString());
    expect(document.body.textContent).not.toContain("dex-stale");
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
        publicationHealth={response.publicationHealth}
        updatedAtMs={null}
      />,
    );

    expect(screen.getByText("Not rated")).toBeTruthy();
    expect(screen.getByText("Required pillar evidence is missing.")).toBeTruthy();
    expect(screen.queryByText(/Pre-cap/)).toBeNull();
  });
});
