// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StablecoinSafetyScoreV9Card } from "@/components/stablecoin-detail/stablecoin-safety-score-v9-card";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";

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
    expect(screen.getByText("Pre-cap 86.9")).toBeTruthy();
    expect(screen.getByText("Backing")).toBeTruthy();
    expect(screen.getByText("Exit")).toBeTruthy();
    expect(screen.getByText("Economic Control")).toBeTruthy();
    expect(screen.getByText("None known")).toBeTruthy();
    expect(screen.queryByText("none-known")).toBeNull();
    expect(screen.getByLabelText("Reserve composition")).toBeTruthy();
    expect(screen.getByText("Binding cap")).toBeTruthy();
    expect(screen.getByRole("link", { name: "USDC" })).toBeTruthy();
    expect(container.querySelector(".lg\\:grid-cols-2")).toBeTruthy();
    expect(container.querySelector('[style*="contain"]')).toBeTruthy();
    expect(screen.queryByText("Resilience")).toBeNull();
    expect(screen.queryByText("Decentralization")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Backing/ }));
    expect(screen.getAllByText("Scored inputs").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Reviewed component").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("img", { name: "1 scored input" }).length).toBeGreaterThan(0);
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
