// @vitest-environment jsdom

import { act } from "react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { EventCard } from "@/components/tape/event-card";
import type { TapeEvent } from "@shared/types/tape-event";

let restoreClipboard: (() => void) | null = null;

function stubClipboard(writeText: Mock) {
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  restoreClipboard = () => {
    restoreClipboard = null;
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else delete (navigator as { clipboard?: unknown }).clipboard;
  };
}

afterEach(() => {
  vi.useRealTimers();
  restoreClipboard?.();
});

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

// One builder per enrichment class; overrides stay visible at the scenario.
function scoreEvent(overrides: Partial<TapeEvent> = {}): TapeEvent {
  return makeEvent({
    type: "score.downgraded",
    severity: "warning",
    title: "USDX grade B → C+",
    summary: "Safety grade downgraded from B to C+.",
    coinId: "usdx-issuer",
    payload: { prevGrade: "B", newGrade: "C+", prevScore: 70, newScore: 65 },
    sourceUrl: "/stablecoin/usdx-issuer/#report-card",
    ...overrides,
  });
}

function methodologyEvent(overrides: Partial<TapeEvent> = {}): TapeEvent {
  return makeEvent({
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
      impact: [],
    },
    sourceUrl: "/methodology/pricing-pipeline-changelog/",
    ...overrides,
  });
}

function freezeEvent(overrides: Partial<TapeEvent> = {}): TapeEvent {
  return makeEvent({
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
      amountUsdAtEvent: 0,
      sourceEventId: "ethereum-0xabc-0x1cf",
    },
    sourceUrl: "/freezewatch/",
    ...overrides,
  });
}

function cemeteryEvent(causeOfDeath: string, overrides: Partial<TapeEvent> = {}): TapeEvent {
  return makeEvent({
    type: "cemetery.entry.added",
    severity: "notice",
    title: "USDH entered cemetery (peak $14.0M)",
    summary: "First Solana CDP, last one standing.",
    coinId: "usdh-hubble-2026-05",
    payload: {
      symbol: "USDH",
      name: "Hubble USDH",
      causeOfDeath,
      deathDate: "2026-05",
      peakMcap: 14_000_000,
      sourceUrl: "https://www.coingecko.com/en/coins/usdh",
      sourceLabel: "CoinGecko",
    },
    sourceUrl: "/cemetery/",
    ...overrides,
  });
}

function lifecycleEvent(overrides: Partial<TapeEvent> = {}): TapeEvent {
  return makeEvent({
    type: "lifecycle.tracked.frozen",
    severity: "notice",
    title: "USDX archived",
    summary: "Archived after issuer wind-down.",
    coinId: "usdx-issuer",
    payload: {
      symbol: "USDX",
      name: "USD Issuer",
      frozenAt: "2026-04-30",
      causeOfDeath: "regulatory",
      sourceUrl: null,
      sourceLabel: null,
    },
    sourceUrl: "/stablecoin/usdx-issuer/",
    ...overrides,
  });
}

describe("EventCard enrichment", () => {
  it("clears the permalink-copy feedback timer on unmount", async () => {
    vi.useFakeTimers();
    stubClipboard(vi.fn().mockResolvedValue(undefined));

    const { unmount } = render(<EventCard event={makeEvent()} />);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy permalink to this event" }));
      await Promise.resolve();
    });
    // The copy landed, and copying scheduled exactly one 1.5s feedback reset.
    expect(screen.getByRole("button", { name: "Permalink copied" })).toBeTruthy();
    const resetCallIndex = setTimeoutSpy.mock.calls.findIndex((args) => args[1] === 1500);
    expect(resetCallIndex).toBeGreaterThanOrEqual(0);
    const feedbackTimerId = setTimeoutSpy.mock.results[resetCallIndex]!.value;

    unmount();

    // Unmount clears exactly the pending feedback timer, not an unrelated handle.
    expect(clearTimeoutSpy.mock.calls.some((args) => args[0] === feedbackTimerId)).toBe(true);
  });

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
    render(<EventCard event={scoreEvent()} />);
    // Grade pills render as separate siblings (not within the title).
    const grades = screen.getAllByText(/^(B|C\+)$/);
    expect(grades.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/70 → 65/)).toBeTruthy();
    expect(screen.getByText(/\(-5\)/)).toBeTruthy();
  });

  it("score.upgraded with null prevScore omits the numeric delta but keeps the pills", () => {
    const event = scoreEvent({
      type: "score.upgraded",
      severity: "info",
      title: "USDX grade C → B",
      summary: "Safety grade upgraded from C to B.",
      payload: { prevGrade: "C", newGrade: "B", prevScore: null, newScore: 70 },
    });
    render(<EventCard event={event} />);
    expect(screen.getByText(/^C$/)).toBeTruthy();
    expect(screen.getByText(/^B$/)).toBeTruthy();
    expect(screen.queryByText(/→ 70/)).toBeNull();
  });

  it("methodology.bumped renders up to two impact bullets and truncates the rest", () => {
    const event = methodologyEvent({
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
    });
    render(<EventCard event={event} />);
    expect(screen.getByText("First impact bullet about XOF tracking")).toBeTruthy();
    expect(screen.getByText("Second impact bullet about price validation")).toBeTruthy();
    expect(screen.queryByText(/Third impact bullet/)).toBeNull();
    expect(screen.queryByText(/Fourth impact bullet/)).toBeNull();
  });

  it("methodology.bumped with empty impact renders no bullet container", () => {
    const { container } = render(<EventCard event={methodologyEvent()} />);
    expect(container.querySelector("ul")).toBeNull();
  });

  it.each([
    {
      action: "unblocked",
      amountUsdAtEvent: 839_738,
      badge: "$840K",
    },
    {
      action: "unblocked",
      amountUsdAtEvent: 0,
      badge: null,
    },
    {
      action: "blocked",
      amountUsdAtEvent: 343_007,
      badge: "$343K",
    },
  ])("freeze.$action with amount $amountUsdAtEvent renders action and badge signals", ({ action, amountUsdAtEvent, badge }) => {
    const blocked = action === "blocked";
    render(
      <EventCard
        event={freezeEvent({
          type: blocked ? "freeze.blocked" : "freeze.unblocked",
          severity: blocked ? "notice" : "info",
          chain: blocked ? "Tron" : "Ethereum",
          title: blocked ? "USDT freeze $343k · Tron" : "USDT address unfrozen · Ethereum",
          payload: {
            stablecoin: "USDT",
            chainId: blocked ? "tron" : "ethereum",
            chainName: blocked ? "Tron" : "Ethereum",
            amountUsdAtEvent,
            sourceEventId: blocked ? "tron-0xdef-1" : "ethereum-0xabc-0x1cf",
          },
        })}
      />,
    );
    if (badge === null) {
      // Zero-amount freezes render no body enrichment at all — no badge and
      // no action label.
      expect(screen.queryByText(/^\$\d/)).toBeNull();
      expect(screen.queryByText("unfrozen")).toBeNull();
      expect(screen.queryByText("frozen")).toBeNull();
    } else {
      expect(screen.getByText(badge)).toBeTruthy();
      expect(screen.getByText(blocked ? "frozen" : "unfrozen")).toBeTruthy();
      expect(screen.getByText((content) => content.includes(`freeze ${action}`))).toBeTruthy();
    }
  });

  it.each(["abandoned", "constructor"])("cemetery renders the %s cause-of-death pill", (causeOfDeath) => {
    render(<EventCard event={cemeteryEvent(causeOfDeath)} />);
    expect(screen.getByText(causeOfDeath)).toBeTruthy();
  });

  it("lifecycle renders the cause pill and the frozen date in absolute form", () => {
    render(<EventCard event={lifecycleEvent()} />);
    expect(screen.getByText("regulatory")).toBeTruthy();
    expect(screen.getByText(/Archived Apr 30, 2026/)).toBeTruthy();
  });

  it("drops the cause pill and archived date when the lifecycle payload clears", () => {
    const { rerender } = render(<EventCard event={lifecycleEvent()} />);
    expect(screen.getByText("regulatory")).toBeTruthy();
    expect(screen.getByText(/Archived Apr 30, 2026/)).toBeTruthy();

    rerender(
      <EventCard
        event={lifecycleEvent({
          payload: {
            symbol: "USDX",
            name: "USD Issuer",
            frozenAt: null,
            causeOfDeath: null,
            sourceUrl: null,
            sourceLabel: null,
          },
        })}
      />,
    );
    expect(screen.queryByText("regulatory")).toBeNull();
    expect(screen.queryByText(/Archived Apr 30, 2026/)).toBeNull();
  });

  it("psi.band.shifted_up renders band pills with one-decimal score delta", () => {
    const event = makeEvent({
      type: "psi.band.shifted_up",
      severity: "info",
      title: "USDX band B → A",
      summary: "Safety band improved.",
      coinId: "usdx-issuer",
      payload: { prevBand: "B", newBand: "A", prevScore: 62.5, newScore: 64.3 },
      sourceUrl: "/stablecoin/usdx-issuer/#report-card",
    });
    render(<EventCard event={event} />);
    expect(screen.getByText(/^B$/)).toBeTruthy();
    expect(screen.getByText(/^A$/)).toBeTruthy();
    expect(screen.getByText("62.5 → 64.3")).toBeTruthy();
    expect(screen.getByText("(+1.8)")).toBeTruthy();
  });

  it("yield.pys_dropped derives the delta from the rounded pills so the triple is consistent", () => {
    const event = makeEvent({
      type: "yield.pys_dropped",
      severity: "warning",
      title: "USDX PYS dropped",
      summary: "PYS fell below threshold.",
      coinId: "usdx-issuer",
      payload: { prevScore: 81.6, newScore: 74.4 },
      sourceUrl: "/stablecoin/usdx-issuer/#yields",
    });
    render(<EventCard event={event} />);
    expect(screen.getByText(/^82$/)).toBeTruthy();
    expect(screen.getByText(/^74$/)).toBeTruthy();
    // 81.6 → 74.4 displays as 82 → 74; the drop shown must be 82 - 74.
    expect(screen.getByText("(-8)")).toBeTruthy();
  });

  it("yield.warning_emitted prefers newSignals and truncates after three pills", () => {
    const event = makeEvent({
      type: "yield.warning_emitted",
      severity: "warning",
      title: "USDX yield warnings",
      summary: "New yield signals emitted.",
      coinId: "usdx-issuer",
      payload: {
        newSignals: ["depeg_watch", "liquidity_drop", "oracle_stale", "utilization_spike"],
        signals: ["legacy_signal"],
      },
      sourceUrl: "/stablecoin/usdx-issuer/#yields",
    });
    render(<EventCard event={event} />);
    expect(screen.getByText("depeg_watch")).toBeTruthy();
    expect(screen.getByText("liquidity_drop")).toBeTruthy();
    expect(screen.getByText("oracle_stale")).toBeTruthy();
    expect(screen.getByText("+1 more")).toBeTruthy();
    // Only newSignals is shown: the superseded legacy signal list must not leak.
    expect(screen.queryByText("utilization_spike")).toBeNull();
    expect(screen.queryByText("legacy_signal")).toBeNull();
  });

  it.each([
    { direction: "mint", amountUsd: 2_500_000, badge: "$2.5M", verb: "minted" },
    { direction: "burn", amountUsd: 750_000, badge: "$750K", verb: "burned" },
    { direction: "mint", amountUsd: 0, badge: null, verb: null },
  ])("mint_burn $direction of $amountUsd renders the flow enrichment", ({ direction, amountUsd, badge, verb }) => {
    const event = makeEvent({
      type: "mint_burn.flow_detected",
      severity: "info",
      title: "USDC treasury flow detected",
      summary: "Net treasury flow detected.",
      coinId: "usdc-circle",
      payload: { amountUsd, direction },
      sourceUrl: "/stablecoin/usdc-circle/",
    });
    render(<EventCard event={event} />);
    if (badge === null || verb === null) {
      // Zero-amount flows render no enrichment at all.
      expect(screen.queryByText(/^\$\d/)).toBeNull();
      expect(screen.queryByText("minted")).toBeNull();
      expect(screen.queryByText("burned")).toBeNull();
    } else {
      expect(screen.getByText(badge)).toBeTruthy();
      expect(screen.getByText(verb)).toBeTruthy();
    }
  });

  it("preserves a single anchor wrapper across all enrichment paths", () => {
    const cases: TapeEvent[] = [
      makeEvent(),
      scoreEvent(),
      methodologyEvent(),
    ];
    for (const event of cases) {
      const { container, unmount } = render(<EventCard event={event} />);
      expect(container.querySelectorAll("a").length).toBe(1);
      unmount();
    }
  });
});
