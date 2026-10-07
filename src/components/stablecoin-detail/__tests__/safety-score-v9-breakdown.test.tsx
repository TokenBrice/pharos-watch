// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { StablecoinSafetyScoreV9Presentation } from "@/lib/stablecoin-safety-score-v9-presentation";
import { SafetyScoreV9PillarRow } from "../safety-score-v9-breakdown";

type Pillar = StablecoinSafetyScoreV9Presentation["pillars"][number];

function pillar(score: number | null): Pillar {
  return {
    key: "exit",
    label: "Exit",
    score,
    evidenceSummary: "Reviewed coverage",
    componentCount: 0,
    components: [],
    breakdown: null,
    reasons: [],
    isWeakest: false,
  };
}

describe("SafetyScoreV9PillarRow", () => {
  it("draws an unscored pillar as an unavailable track, never an empty bar that reads as zero", () => {
    render(<SafetyScoreV9PillarRow cardId="card" pillar={pillar(null)} />);
    const bar = screen.getByRole("img", { name: /^Exit:/ });
    expect(bar.getAttribute("aria-label")).toMatch(/unavailable/);
    expect(bar.childElementCount).toBe(0);
  });

  it("fills a scored pillar's bar and names its score", () => {
    render(<SafetyScoreV9PillarRow cardId="card" pillar={pillar(84)} />);
    const bar = screen.getByRole("img", { name: /^Exit:/ });
    expect(bar.getAttribute("aria-label")).toContain("84 out of 100");
    expect(bar.childElementCount).toBe(1);
  });

  it.each([
    { visibility: undefined, linked: true },
    { visibility: "all" as const, linked: true },
    { visibility: "below-xl" as const, linked: true },
    { visibility: "none" as const, linked: false },
  ])("links to its evidence board only where the board renders ($visibility)", ({ visibility, linked }) => {
    render(<SafetyScoreV9PillarRow cardId="card" pillar={pillar(84)} evidenceVisibility={visibility} />);
    const link = screen.queryByRole("link", { name: "Exit evidence" });
    expect(link?.getAttribute("href") ?? null).toBe(linked ? "#exit-evidence" : null);
  });
});
