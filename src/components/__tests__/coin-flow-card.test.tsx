import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CoinFlowCard } from "@/components/coin-flow-card";
import { buildFlowSummaryNarrative } from "@/lib/flow-signal-ui";

const mintingProps = {
  symbol: "USDT",
  color: "#3b82f6",
  netFlow24hUsd: 1_240_000_000,
  pressureShiftScore: 58,
  netFlowDirection24h: "minting" as const,
  pressureShiftState: "improving" as const,
};

const burningProps = {
  symbol: "USDC",
  color: "#ef4444",
  netFlow24hUsd: -340_000_000,
  pressureShiftScore: -28,
  netFlowDirection24h: "burning" as const,
  pressureShiftState: "worsening" as const,
};

const nrProps = {
  symbol: "USDS",
  color: "#10b981",
  netFlow24hUsd: 0,
  pressureShiftScore: null,
  netFlowDirection24h: "inactive" as const,
  pressureShiftState: "nr" as const,
};

describe("CoinFlowCard", () => {
  it("renders minting amount and improving pressure", () => {
    const html = renderToStaticMarkup(<CoinFlowCard {...mintingProps} />);
    expect(html).toContain("USDT");
    expect(html).toContain("+$1.24B");
    expect(html).toContain("Improving");
    expect(html).toContain("58");
  });

  it("renders burning amount and worsening pressure", () => {
    const html = renderToStaticMarkup(<CoinFlowCard {...burningProps} />);
    expect(html).toContain("-$340.00M");
    expect(html).toContain("-28");
    expect(html).toContain("Worsening");
  });

  it("renders NR for unrated pressure", () => {
    const html = renderToStaticMarkup(<CoinFlowCard {...nrProps} />);
    expect(html).toContain("NR");
    expect(html).not.toContain("Improving");
    expect(html).not.toContain("Worsening");
  });
});

describe("buildFlowSummaryNarrative", () => {
  it.each([
    ["burning", "improving", /burning/i, /easing/i],
    ["burning", "stable", /burning/i, /usual/i],
    ["burning", "worsening", /burning/i, /worsening/i],
    ["minting", "improving", /minting/i, /stronger/i],
    ["minting", "stable", /minting/i, /usual/i],
    ["minting", "worsening", /minting/i, /weaker/i],
    ["flat", "improving", /flat/i, /stronger/i],
    ["flat", "stable", /flat/i, /close/i],
    ["flat", "worsening", /flat/i, /weaker/i],
    ["burning", "nr", /burning/i, /\bNR\b/],
    ["minting", "nr", /minting/i, /\bNR\b/],
    ["flat", "nr", /flat/i, /\bNR\b/],
    ["inactive", "improving", /no .*activity/i, /\bNR\b/],
  ] as const)("preserves %s direction and %s pressure meaning", (direction, state, directionMeaning, pressureMeaning) => {
    const narrative = buildFlowSummaryNarrative(direction, state);
    expect(narrative).toMatch(directionMeaning);
    expect(narrative).toMatch(pressureMeaning);
  });
});
