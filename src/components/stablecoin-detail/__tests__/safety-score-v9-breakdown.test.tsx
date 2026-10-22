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
    pricedUnknown: null,
    evidenceSummary: "Reviewed coverage",
    evidenceDescription: null,
    componentCount: 0,
    components: [],
    breakdown: null,
    reasons: [],
  };
}

describe("SafetyScoreV9PillarRow", () => {
  it("draws an unscored pillar as an unavailable track, never an empty bar that reads as zero", () => {
    render(<SafetyScoreV9PillarRow cardId="card" pillar={pillar(null)} />);
    const bar = screen.getByRole("img", { name: /^Exit:/ });
    expect(bar.getAttribute("aria-label")).toMatch(/unavailable/);
    expect(bar.childElementCount).toBe(0);
  });

  it.each([
    { cause: "C" as const, score: 35, reason: "undisclosed by issuer" },
    { cause: "U" as const, score: 50, reason: "not yet researched" },
    { cause: "U" as const, score: 60, reason: "not yet researched" },
  ])("names a $cause priced unknown without calling it excluded", ({ cause, score, reason }) => {
    const { container } = render(<SafetyScoreV9PillarRow cardId="card" pillar={{ ...pillar(null), pricedUnknown: { cause, score } }} />);
    expect(container.textContent).toContain("Unknown");
    expect(container.textContent).toContain(`${reason.charAt(0).toUpperCase()}${reason.slice(1)} · assumed ${score}/100`);
    expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(`Exit: unknown, ${reason} · assumed ${score}/100`);
    expect(container.textContent).not.toMatch(/Not scored|Excluded/);
    expect(container.querySelector('[role="img"]')?.childElementCount).toBe(0);
  });

  it("fills a scored pillar's bar and names its score", () => {
    render(<SafetyScoreV9PillarRow cardId="card" pillar={pillar(84)} />);
    const bar = screen.getByRole("img", { name: /^Exit:/ });
    expect(bar.getAttribute("aria-label")).toContain("84 out of 100");
    expect(bar.childElementCount).toBe(1);
  });

  it.each([
    { visibility: undefined, linked: true },
    { visibility: "none" as const, linked: false },
  ])("links to its evidence board only where the board renders ($visibility)", ({ visibility, linked }) => {
    render(<SafetyScoreV9PillarRow cardId="card" pillar={pillar(84)} evidenceVisibility={visibility} />);
    const link = screen.queryByRole("link", { name: "Exit evidence" });
    expect(link?.getAttribute("href") ?? null).toBe(linked ? "#exit-evidence" : null);
  });
});
