import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CoinFlowCard } from "@/components/coin-flow-card";
import { buildFlowSummaryNarrative } from "@/lib/flow-signal-ui";

const mintingProps = {
  symbol: "USDT",
  color: "#3b82f6",
  netFlow24h: { valueUsd: 1_240_000_000, completeness: "complete" as const, note: null },
  pressureShiftScore: 58,
  pressureUnavailableNote: null,
  netFlowDirection24h: "minting" as const,
  pressureShiftState: "improving" as const,
};

const burningProps = {
  symbol: "USDC",
  color: "#ef4444",
  netFlow24h: { valueUsd: -340_000_000, completeness: "complete" as const, note: null },
  pressureShiftScore: -28,
  pressureUnavailableNote: null,
  netFlowDirection24h: "burning" as const,
  pressureShiftState: "worsening" as const,
};

const nrProps = {
  symbol: "USDS",
  color: "#10b981",
  netFlow24h: { valueUsd: 0, completeness: "complete" as const, note: null },
  pressureShiftScore: null,
  pressureUnavailableNote: null,
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

  it("preserves observed zero net flow while rendering NR for unrated pressure", () => {
    const html = renderToStaticMarkup(<CoinFlowCard {...nrProps} />);
    expect(html).toContain("NR");
    expect(html).toContain("$0.00");
    expect(html).not.toContain("Improving");
    expect(html).not.toContain("Worsening");
  });

  it("renders a partial 24h window as unavailable, not a signed amount, flat, or burning", () => {
    const html = renderToStaticMarkup(
      <CoinFlowCard
        {...burningProps}
        netFlow24h={{
          valueUsd: null,
          completeness: "partial",
          note: "Partial valuation: 2 mint / 0 burn events unpriced; signed net unavailable",
        }}
        netFlowDirection24h={null}
        pressureShiftScore={null}
        pressureShiftState="nr"
        pressureUnavailableNote="Partial valuation: pressure shift unavailable"
      />,
    );
    expect(html).toContain("2 mint / 0 burn events unpriced; signed net unavailable");
    expect(html).not.toContain("$");
    expect(html).not.toMatch(/\b(Flat|Burning|Worsening)\b/);
    expect(html).toContain("NR");
    expect(html).toContain("Partial valuation: pressure shift unavailable");
  });

  it("keeps a coverage-unknown net visible with a marker", () => {
    const html = renderToStaticMarkup(
      <CoinFlowCard
        {...mintingProps}
        netFlow24h={{ valueUsd: 1_240_000_000, completeness: "unknown", note: "Coverage unknown" }}
      />,
    );
    expect(html).toContain("+$1.24B");
    expect(html).toContain("(coverage unknown)");
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
