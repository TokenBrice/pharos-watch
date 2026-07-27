// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MobileRiskSnapshot } from "../mobile-risk-snapshot";
import { makeV9Card } from "@/test/fixtures/safety-score-v9";

const REPORT_CARD = makeV9Card({
  score: 79,
  grade: "B+",
  qualityScore: 79,
  pillars: {
    backing: {
      score: 88,
      evidenceLevel: "adequate",
      freshness: "current",
      components: ["reserve-quality"],
      reasons: [],
    },
    exit: {
      score: 82,
      evidenceLevel: "adequate",
      freshness: "current",
      components: ["exit-liquidity"],
      reasons: [],
    },
    control: {
      score: 66,
      evidenceLevel: "adequate",
      freshness: "current",
      components: ["economic-control"],
      reasons: [],
    },
  },
  weakestPillar: { pillar: "control", score: 66 },
});

afterEach(cleanup);

describe("MobileRiskSnapshot", () => {
  it("renders nothing without a report card", () => {
    const { container } = render(<MobileRiskSnapshot reportCard={null} />);

    expect(container.textContent).toBe("");
  });

  it("summarizes the V9 grade, pillars, and weakest pillar", () => {
    render(<MobileRiskSnapshot reportCard={REPORT_CARD} />);

    expect(screen.getByText("Risk Snapshot")).toBeTruthy();
    expect(screen.getByText("Backing")).toBeTruthy();
    expect(screen.getByText("88 / 100")).toBeTruthy();
    expect(screen.getByText("Exit")).toBeTruthy();
    expect(screen.getByText("82 / 100")).toBeTruthy();
    expect(screen.getByText("Economic control")).toBeTruthy();
    expect(screen.getByText("66 / 100")).toBeTruthy();
    expect(screen.getByText("control is the weakest pillar at 66 / 100.")).toBeTruthy();
  });
});
