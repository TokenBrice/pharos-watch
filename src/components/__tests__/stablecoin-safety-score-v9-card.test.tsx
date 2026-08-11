// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SafetyScoreV9CurrentCardSchema } from "@shared/types/safety-score-v9-public";
import { StablecoinSafetyScoreV9Card } from "@/components/stablecoin-detail/stablecoin-safety-score-v9-card";
import { makeReportCardsV9Response, makeV9Card, makeV9Pillars } from "@/test/fixtures/safety-score-v9";

// The shared V9 card fixture derives its pillars from one default quality
// score; these suites assert on specific pillar values and on which pillar is
// weakest (the card auto-expands it), so they declare their pillars.
const EXIT_WEAKEST_PILLARS = makeV9Pillars({ backing: 88, exit: 84, control: 86 });

describe("StablecoinSafetyScoreV9Card", () => {
  afterEach(cleanup);

  it("renders rated V9 data and reserve composition in one responsive card", () => {
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
        serial: [{ upstreamAssetId: "usdc-circle", score: 84, blocked: false }],
        basket: [],
        cycleBlocked: false,
        reasonCodes: [],
      },
    });
    card.scoreTrace.stages.preCapScore = 86.9;
    const response = makeReportCardsV9Response({ cards: [card] });

    const { container } = render(
      <StablecoinSafetyScoreV9Card
        card={card}
        identity={response.safetyScoreIdentity}
        publicationHealth={response.publicationHealth}
        updatedAtMs={response.updatedAt * 1000}
        stablecoinName="Test Stablecoin"
        rightColumn={<section aria-label="Reserve composition">Reserve treemap</section>}
      />,
    );

    expect(screen.getAllByText("A").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/84/).length).toBeGreaterThan(0);
    expect(screen.queryByText("Pre-cap 86.9")).toBeNull();
    expect(screen.getByLabelText("How this score is built")).toBeTruthy();
    expect(screen.getByText("Backing")).toBeTruthy();
    expect(screen.getByText("Exit")).toBeTruthy();
    expect(screen.getByText("Economic Control")).toBeTruthy();
    expect(screen.getByText("None known")).toBeTruthy();
    expect(screen.queryByText("none-known")).toBeNull();
    expect(screen.getByLabelText("Reserve composition")).toBeTruthy();
    expect(screen.getByText("Binding cap")).toBeTruthy();
    expect(container.querySelector(".lg\\:grid-cols-2")).toBeTruthy();
    expect(container.querySelector('[style*="contain"]')).toBeTruthy();
    expect(screen.queryByText("Resilience")).toBeNull();
    expect(screen.queryByText("Decentralization")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Backing/ }));
    expect(screen.getAllByText("Backing components").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Reviewed reserves").length).toBeGreaterThan(0);
    expect(screen.getByRole("img", { name: "Reviewed reserves: 88 out of 100, 100% weight" })).toBeTruthy();
  });

  it("renders weighted component bars and control binding semantics from V9 breakdowns", () => {
    const card = makeV9Card({ pillars: EXIT_WEAKEST_PILLARS });
    card.breakdowns = {
      backing: {
        evaluatedScore: 86,
        publishedScore: 88,
        aggregationWeight: 0.4,
        groups: [{ key: "reserves", label: "Reserves", score: 86, effectiveWeight: 1 }],
        components: [{
          key: "reserve:reserve:wsteth",
          label: "wstETH",
          source: "reserve-exposure",
          score: 86,
          effectiveWeight: 1,
          weightedContribution: 86,
          observationState: "known",
        }],
        adjustments: [{
          kind: "operational-resilience-credit",
          scoreBefore: 86,
          scoreAfter: 88,
          delta: 2,
        }],
      },
      exit: {
        evaluatedScore: 84,
        publishedScore: 84,
        aggregationWeight: 0.35,
        stressRequest: {
          requestedNotionalUsd: 10_000_000,
          maxCostBps: 100,
          comparisonWindowSec: 86_400,
        },
        primaryRoute: {
          key: "redemption:primary",
          label: "Direct redemption",
          routeFamily: "issuer-redemption",
          score: 84,
          components: [
            { key: "access", label: "Access", score: 90, weight: 0.2, weightedContribution: 18 },
            { key: "settlement", label: "Settlement", score: 84, weight: 0.15, weightedContribution: 12.6 },
            { key: "executionCertainty", label: "Execution certainty", score: 80, weight: 0.15, weightedContribution: 12 },
            { key: "capacity", label: "Capacity", score: 78, weight: 0.25, weightedContribution: 19.5 },
            { key: "outputAssetQuality", label: "Output asset quality", score: 92, weight: 0.15, weightedContribution: 13.8 },
            { key: "cost", label: "Cost", score: 81, weight: 0.1, weightedContribution: 8.1 },
          ],
          confidenceFactor: 1,
          eligibilityMultiplier: 1,
          capsApplied: [],
        },
        diversification: null,
        alternatives: [{
          key: "dex:curve",
          label: "Curve liquidity",
          routeFamily: "dex-amm",
          score: 77,
          included: true,
          exclusionReason: null,
        }],
        adjustments: [],
      },
      control: {
        evaluatedScore: 86,
        publishedScore: 86,
        aggregationWeight: 0.25,
        method: "minimum-binding-component",
        components: [
          { key: "mint", label: "Mint authority", kind: "mint", score: 86, binding: true, posture: "concentrated" },
          { key: "oracle", label: "Oracle design", kind: "oracle", score: 95, binding: false, posture: "distributed" },
        ],
        adjustments: [],
      },
    };
    const validatedCard = SafetyScoreV9CurrentCardSchema.parse(card);
    const response = makeReportCardsV9Response({ cards: [validatedCard] });

    render(
      <StablecoinSafetyScoreV9Card
        card={validatedCard}
        identity={response.safetyScoreIdentity}
        publicationHealth={response.publicationHealth}
        updatedAtMs={response.updatedAt * 1000}
        rightColumn={<section aria-label="Reserve composition">Reserve treemap</section>}
      />,
    );

    // Pillars start folded on every viewport; open Exit to inspect its route
    // breakdown before asserting the selected-route details.
    fireEvent.click(screen.getByRole("button", { name: /Exit/ }));
    expect(screen.getByText("Primary route components — Direct redemption")).toBeTruthy();
    expect(screen.getByText(/Primary V9 route: Direct redemption 84\.0/)).toBeTruthy();
    expect(screen.getByRole("img", { name: "Access: 90 out of 100, 20% weight" })).toBeTruthy();
    expect(screen.getByRole("img", {
      name: "Capacity score — selected route: 78 out of 100, 25% weight",
    })).toBeTruthy();
    expect(screen.getByText("35% aggregation weight")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Backing/ }));
    expect(screen.getByText("Backing components")).toBeTruthy();
    expect(screen.getByRole("img", { name: "wstETH: 86 out of 100, 100% weight" })).toBeTruthy();
    expect(screen.getByText("Evaluator to published")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Economic Control/ }));
    expect(screen.getByText("Control components")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Mint authority: 86 out of 100" })).toBeTruthy();
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
      name: "Capacity score — selected route: <1 out of 100, 25% weight",
    })).toBeTruthy();
  });

  it("renders held publication wording across the card with an exact time value", () => {
    const card = makeV9Card();
    const response = makeReportCardsV9Response({
      cards: [card],
      publicationHealth: {
        schemaVersion: 1,
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
        rightColumn={<div>Reserve treemap</div>}
      />,
    );

    const notice = screen.getByText(/Ratings held at the last verified snapshot/).closest('[role="status"]')!;
    expect(notice.textContent).toContain("Ratings held at the last verified snapshot");
    expect(notice.querySelector("time")?.getAttribute("datetime")).toBeTruthy();
    expect(notice.nextElementSibling?.className).toContain("grid");
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
