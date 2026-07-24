// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReportCardV9Detail } from "@/components/report-card-v9";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";

describe("ReportCardV9Detail", () => {
  afterEach(cleanup);

  it("renders native pillars, caps, evidence, access posture, and dependencies only", () => {
    const bindingCap = {
      kind: "control-ceiling",
      limit: 80,
      source: "structural" as const,
      reason: "Single-entity control limits the result.",
      binding: true,
    };
    const cards = [
      makeV9Card({ id: "asset-a" }),
      makeV9Card({
        id: "asset-b",
        score: 80,
        grade: "A-",
        caps: [bindingCap],
        bindingCap,
        dependencies: {
          serial: [{ upstreamAssetId: "asset-a", score: 84, blocked: false }],
          basket: [],
          cycleBlocked: false,
          reasonCodes: [],
        },
        reasonCodes: ["mint-control-question"],
      }),
    ];
    const response = makeReportCardsV9Response({ cards });

    render(<ReportCardV9Detail response={response} expectedIdentity={response.safetyScoreIdentity} cardId="asset-b" />);

    expect(screen.getByText("Backing quality")).toBeTruthy();
    expect(screen.getByText("Exit quality")).toBeTruthy();
    expect(screen.getByText("Control quality")).toBeTruthy();
    expect(screen.getByText("Binding cap")).toBeTruthy();
    expect(screen.getByText(/Single-entity control limits/)).toBeTruthy();
    expect(screen.getByText("Evidence")).toBeTruthy();
    expect(screen.getByText("Access posture")).toBeTruthy();
    expect(screen.getByText("Dependencies")).toBeTruthy();
    expect(screen.getByRole("link", { name: "asset-a" })).toBeTruthy();
    expect(screen.queryByText(/Base:/)).toBeNull();
    expect(screen.queryByText(/Peg:/)).toBeNull();
    expect(screen.queryByText("Resilience")).toBeNull();
    expect(screen.queryByText("Decentralization")).toBeNull();
    expect(screen.queryByText("Show inputs")).toBeNull();
  });

  it("renders an explicit NR reason", () => {
    const card = makeV9Card({
      score: null,
      grade: "NR",
      qualityScore: null,
      pegMultiplier: null,
      pegAdjustedScore: null,
      pillars: {
        backing: { score: null, evidenceLevel: "insufficient", freshness: "unknown", components: [], reasons: [] },
        exit: { score: null, evidenceLevel: "insufficient", freshness: "unknown", components: [], reasons: [] },
        control: { score: null, evidenceLevel: "insufficient", freshness: "unknown", components: [], reasons: [] },
      },
      weakestPillar: null,
      nrReasons: [{ code: "missing-pillar", message: "Required pillar evidence is missing.", field: "backing", origin: "asset" }],
    });
    const response = makeReportCardsV9Response({ cards: [card] });
    render(<ReportCardV9Detail response={response} expectedIdentity={response.safetyScoreIdentity} cardId={card.id} />);
    expect(screen.getByText("Not rated")).toBeTruthy();
    expect(screen.getByText("Required pillar evidence is missing.")).toBeTruthy();
  });

  it("does not render stale data after an expected identity change", () => {
    const response = makeReportCardsV9Response();
    render(
      <ReportCardV9Detail
        response={response}
        expectedIdentity={{ ...response.safetyScoreIdentity, publicationGenerationId: "v9-publication-2" }}
        cardId="usdc-circle"
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("publication identity changed");
    expect(screen.queryByText("Backing quality")).toBeNull();
  });
});
