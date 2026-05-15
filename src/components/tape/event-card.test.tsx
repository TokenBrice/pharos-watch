// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { EventCard } from "@/components/tape/event-card";
import type { TapeEvent } from "@shared/types/tape-event";

afterEach(cleanup);

function makeEvent(overrides: Partial<TapeEvent> = {}): TapeEvent {
  return {
    id: "evt-test",
    type: "depeg.opened",
    severity: "warning",
    ts: Date.now() - 60_000,
    endsAt: null,
    coinId: "usdc-circle",
    issuerId: null,
    pegCurrency: "USD",
    chain: null,
    title: "USDC depeg opened (-300 bps)",
    summary: "USDC drifted to -300 bps versus its USD peg.",
    payload: {
      symbol: "USDC",
      direction: "below",
      absDeviationBps: 300,
      signedDeviationBps: -300,
      pegReference: 1,
      startedAt: Math.floor(Date.now() / 1000),
      endedAt: null,
    },
    sourceTable: "depeg_events",
    sourceRowId: "1",
    transition: "opened",
    sourceUrl: "/stablecoin/usdc-circle/#peg-history",
    methodologyVersion: null,
    ...overrides,
  };
}

describe("EventCard enrichment", () => {
  it("depeg.opened renders signed bps text and an SR-only directional description", () => {
    render(<EventCard event={makeEvent()} />);
    expect(screen.getByText(/^−300 bps$/)).toBeTruthy();
    expect(screen.getByText(/Deviation: −300 basis points, below peg/)).toBeTruthy();
  });

  it("depeg.opened with above-peg deviation renders the + sign and the above descriptor", () => {
    const event = makeEvent({
      title: "EURS depeg opened (+589 bps)",
      payload: {
        symbol: "EURS",
        direction: "above",
        absDeviationBps: 589,
        signedDeviationBps: 589,
        pegReference: 1.17,
        startedAt: Math.floor(Date.now() / 1000),
        endedAt: null,
      },
      coinId: "eurs-stasis",
    });
    render(<EventCard event={event} />);
    expect(screen.getByText(/^\+589 bps$/)).toBeTruthy();
    expect(screen.getByText(/Deviation: \+589 basis points, above peg/)).toBeTruthy();
  });

  it("depeg.peak_worsened renders prev → curr delta in monospace", () => {
    const event = makeEvent({
      type: "depeg.peak_worsened",
      title: "USDC depeg peak worsened (-450 bps)",
      payload: {
        symbol: "USDC",
        direction: "below",
        absDeviationBps: 450,
        prevAbsDeviationBps: 300,
        signedDeviationBps: -450,
        pegReference: 1,
        startedAt: Math.floor(Date.now() / 1000),
        depegEventId: 1,
      },
    });
    render(<EventCard event={event} />);
    expect(screen.getByText("−300 → −450")).toBeTruthy();
  });

  it("score.downgraded renders both grade pills and numeric score delta", () => {
    const event = makeEvent({
      type: "score.downgraded",
      severity: "warning",
      title: "USDX grade B → C+",
      summary: "Safety grade downgraded from B to C+.",
      coinId: "usdx-issuer",
      payload: {
        prevGrade: "B",
        newGrade: "C+",
        prevScore: 70,
        newScore: 65,
      },
      sourceUrl: "/stablecoin/usdx-issuer/#report-card",
    });
    render(<EventCard event={event} />);
    // Grade pills render as separate siblings (not within the title).
    const grades = screen.getAllByText(/^(B|C\+)$/);
    expect(grades.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/70 → 65/)).toBeTruthy();
    expect(screen.getByText(/\(-5\)/)).toBeTruthy();
  });

  it("score.upgraded with null prevScore omits the numeric delta but keeps the pills", () => {
    const event = makeEvent({
      type: "score.upgraded",
      severity: "info",
      title: "USDX grade C → B",
      summary: "Safety grade upgraded from C to B.",
      coinId: "usdx-issuer",
      payload: {
        prevGrade: "C",
        newGrade: "B",
        prevScore: null,
        newScore: 70,
      },
      sourceUrl: "/stablecoin/usdx-issuer/#report-card",
    });
    render(<EventCard event={event} />);
    expect(screen.getByText(/^C$/)).toBeTruthy();
    expect(screen.getByText(/^B$/)).toBeTruthy();
    expect(screen.queryByText(/→ 70/)).toBeNull();
  });

  it("methodology.bumped renders up to two impact bullets and truncates the rest", () => {
    const event = makeEvent({
      type: "methodology.bumped:pricing-pipeline",
      severity: "info",
      coinId: null,
      title: "Pricing Pipeline v6.03: XOF secondary FX peg support",
      summary: "West African CFA franc pegs now have explicit XOF metadata.",
      payload: {
        domain: "pricing-pipeline",
        version: "6.03",
        title: "XOF secondary FX peg support",
        date: "2026-05-14",
        effectiveAt: 1778769294,
        impact: [
          "First impact bullet about XOF tracking",
          "Second impact bullet about price validation",
          "Third impact bullet should be hidden",
          "Fourth impact bullet should be hidden",
        ],
      },
      sourceUrl: "/methodology/pricing-pipeline-changelog/",
    });
    render(<EventCard event={event} />);
    expect(screen.getByText("First impact bullet about XOF tracking")).toBeTruthy();
    expect(screen.getByText("Second impact bullet about price validation")).toBeTruthy();
    expect(screen.queryByText(/Third impact bullet/)).toBeNull();
    expect(screen.queryByText(/Fourth impact bullet/)).toBeNull();
  });

  it("methodology.bumped with empty impact renders no bullet container", () => {
    const event = makeEvent({
      type: "methodology.bumped:safety-score",
      severity: "info",
      coinId: null,
      title: "Safety Score v7.24: Tweak",
      summary: "Tweak.",
      payload: {
        domain: "safety-score",
        version: "7.24",
        title: "Tweak",
        date: "2026-05-10",
        effectiveAt: 0,
        impact: [],
      },
      sourceUrl: "/methodology/scoring-changelog/",
    });
    const { container } = render(<EventCard event={event} />);
    expect(container.querySelector("ul")).toBeNull();
  });

  it("non-enriched class (freeze) renders no enrichment fragment", () => {
    const event = makeEvent({
      type: "freeze.unblocked",
      severity: "info",
      coinId: null,
      chain: "Ethereum",
      title: "USDT address unfrozen · Ethereum",
      summary: "Issuer removed an address from the blacklist.",
      payload: {
        stablecoin: "USDT",
        chainId: "ethereum",
        chainName: "Ethereum",
        amountUsdAtEvent: 839738,
        sourceEventId: "ethereum-0xabc-0x1cf",
      },
      sourceUrl: "/freezewatch/",
    });
    const { container } = render(<EventCard event={event} />);
    expect(container.querySelector("ul")).toBeNull();
    expect(screen.queryByText(/bps/)).toBeNull();
  });

  it("preserves a single anchor wrapper across all enrichment paths", () => {
    const cases: TapeEvent[] = [
      makeEvent(),
      makeEvent({
        type: "score.downgraded",
        severity: "warning",
        title: "USDX grade B → C+",
        coinId: "usdx-issuer",
        payload: { prevGrade: "B", newGrade: "C+", prevScore: 70, newScore: 65 },
        sourceUrl: "/stablecoin/usdx-issuer/#report-card",
      }),
      makeEvent({
        type: "methodology.bumped:pricing-pipeline",
        coinId: null,
        title: "Pricing Pipeline v6.03",
        payload: {
          domain: "pricing-pipeline",
          version: "6.03",
          title: "X",
          date: "2026-05-14",
          effectiveAt: 0,
          impact: ["one", "two"],
        },
        sourceUrl: "/methodology/pricing-pipeline-changelog/",
      }),
    ];
    for (const event of cases) {
      const { container, unmount } = render(<EventCard event={event} />);
      expect(container.querySelectorAll("a").length).toBe(1);
      unmount();
    }
  });
});
