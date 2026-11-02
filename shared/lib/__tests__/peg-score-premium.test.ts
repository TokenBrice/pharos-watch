import { describe, expect, it } from "vitest";
import type { DepegEvent } from "@shared/types/market";
import { makePegEvent } from "@shared/test-utils/peg-fixtures";
import { computePegScore, computePremiumWeightedPegScore } from "../peg-score";

const NOW = 1_700_000_000;
const DAY = 86_400;
const START = NOW - 365 * DAY;

function closed(
  startedAt: number,
  endedAt: number,
  peakDeviationBps: number,
  overrides: Partial<DepegEvent> = {},
): DepegEvent {
  return makePegEvent({ startedAt, endedAt, peakDeviationBps, ...overrides });
}

function active(
  startedAt: number,
  peakDeviationBps: number,
  overrides: Partial<DepegEvent> = {},
): DepegEvent {
  return {
    ...makePegEvent({ startedAt, endedAt: null, peakDeviationBps, ...overrides }),
    priceCoverage: { intervals: [[startedAt, NOW]], lastTrustedObservationAt: NOW, gapStartedAt: null },
  };
}

function blind(
  startedAt: number,
  peakDeviationBps: number,
  overrides: Partial<DepegEvent> = {},
): DepegEvent {
  // An uninstrumented open row proves no observed second: its whole span is unknown.
  return makePegEvent({ startedAt, endedAt: null, peakDeviationBps, ...overrides });
}

describe("computePremiumWeightedPegScore", () => {
  const fixtures: Array<{ name: string; events: DepegEvent[]; start: number | null; now: number }> = [
    {
      name: "below-only closed events",
      events: [closed(NOW - 120 * DAY, NOW - 119 * DAY, -250), closed(NOW - 40 * DAY, NOW - 39 * DAY, -800)],
      start: START,
      now: NOW,
    },
    {
      name: "above-only closed events",
      events: [closed(NOW - 90 * DAY, NOW - 80 * DAY, 300), closed(NOW - 20 * DAY, NOW - 19 * DAY, 1_500)],
      start: START,
      now: NOW,
    },
    {
      name: "mixed signs with spread",
      events: [
        closed(NOW - 200 * DAY, NOW - 190 * DAY, -100),
        closed(NOW - 150 * DAY, NOW - 140 * DAY, -900),
        closed(NOW - 60 * DAY, NOW - 40 * DAY, 700),
      ],
      start: START,
      now: NOW,
    },
    {
      name: "open trusted active discount",
      events: [active(NOW - 2 * DAY, -900)],
      start: START,
      now: NOW,
    },
    {
      name: "open trusted active premium",
      events: [active(NOW - 2 * DAY, 900)],
      start: START,
      now: NOW,
    },
    {
      name: "low-confidence events of both signs",
      events: [
        closed(NOW - 70 * DAY, NOW - 69 * DAY, -600, { provenance: { confidenceTier: "low" } }),
        closed(NOW - 50 * DAY, NOW - 49 * DAY, 900, { provenance: { confidenceTier: "low" } }),
        closed(NOW - 20 * DAY, NOW - 19 * DAY, -150),
      ],
      start: START,
      now: NOW,
    },
    {
      name: "audit-excluded events of both signs",
      events: [
        closed(NOW - 60 * DAY, NOW - 59 * DAY, -5_000, { provenance: { auditVerdict: "false_positive" } }),
        closed(NOW - 40 * DAY, NOW - 39 * DAY, 9_000, { provenance: { auditVerdict: "disputed" } }),
        closed(NOW - 20 * DAY, NOW - 19 * DAY, -120),
      ],
      start: START,
      now: NOW,
    },
    {
      name: "blind coverage and unknown seconds",
      events: [blind(NOW - 60 * DAY, 800), closed(NOW - 20 * DAY, NOW - 19 * DAY, -300)],
      start: START,
      now: NOW,
    },
    {
      name: "insufficient data",
      events: [closed(NOW - 2 * DAY, NOW - DAY, -900)],
      start: NOW - 3 * DAY,
      now: NOW,
    },
    {
      name: "events outside the window",
      events: [closed(START - 30 * DAY, START, -9_000), closed(NOW + DAY, NOW + 2 * DAY, 8_000)],
      start: START,
      now: NOW,
    },
    {
      name: "no tracking start",
      events: [closed(NOW - 30 * DAY, NOW - 20 * DAY, -400)],
      start: null,
      now: NOW,
    },
    {
      name: "empty history",
      events: [],
      start: NOW - 30 * DAY,
      now: NOW,
    },
  ];

  it.each(fixtures)("matches the public peg score at weight 1 for $name", ({ events, start, now }) => {
    expect(computePremiumWeightedPegScore(events, start, now, 1)).toBe(computePegScore(events, start, now).pegScore);
  });

  it("raises the score when premiums exist", () => {
    const start = NOW - 100 * DAY;
    const events = [closed(NOW - 90 * DAY, NOW - 70 * DAY, 1_500), closed(NOW - 30 * DAY, NOW - 29 * DAY, -200)];

    const unweighted = computePremiumWeightedPegScore(events, start, NOW, 1);
    const weighted = computePremiumWeightedPegScore(events, start, NOW, 0.25);

    expect(weighted).toBeGreaterThan(unweighted!);
  });

  it("is identical across weights when no premiums exist", () => {
    const events = [closed(NOW - 120 * DAY, NOW - 119 * DAY, -250), closed(NOW - 40 * DAY, NOW - 39 * DAY, -800)];

    expect(computePremiumWeightedPegScore(events, START, NOW, 0.25)).toBe(
      computePremiumWeightedPegScore(events, START, NOW, 1),
    );
  });

  it("equals the below-only subset at weight 0 when premiums do not overlap", () => {
    const below = [closed(NOW - 80 * DAY, NOW - 75 * DAY, -300), closed(NOW - 50 * DAY, NOW - 45 * DAY, -1_200)];
    const premiums = [closed(NOW - 30 * DAY, NOW - 25 * DAY, 900), closed(NOW - 10 * DAY, NOW - 9 * DAY, 2_500)];

    expect(computePremiumWeightedPegScore([...below, ...premiums], START, NOW, 0)).toBe(
      computePegScore(below, START, NOW).pegScore,
    );
  });

  it("classifies by peak sign, never by direction", () => {
    const mislabeledDiscount = makePegEvent({
      startedAt: NOW - 60 * DAY,
      endedAt: NOW - 50 * DAY,
      peakDeviationBps: -800,
      direction: "above",
    });
    expect(computePremiumWeightedPegScore([mislabeledDiscount], START, NOW, 0.25)).toBe(
      computePremiumWeightedPegScore([mislabeledDiscount], START, NOW, 1),
    );
    expect(computePremiumWeightedPegScore([mislabeledDiscount], START, NOW, 1)).toBe(
      computePegScore([mislabeledDiscount], START, NOW).pegScore,
    );

    const mislabeledPremium = makePegEvent({
      startedAt: NOW - 60 * DAY,
      endedAt: NOW - 40 * DAY,
      peakDeviationBps: 800,
      direction: "below",
    });
    expect(computePremiumWeightedPegScore([mislabeledPremium], START, NOW, 0.25)).toBeGreaterThan(
      computePremiumWeightedPegScore([mislabeledPremium], START, NOW, 1)!,
    );
  });

  it("attributes an overlapping premium to the discount: 10 days + 0.25 × 5 days", () => {
    const start = NOW - 20 * DAY;
    const discountStart = NOW - 20 * DAY;
    const premiumStart = NOW - 15 * DAY;
    const events = [
      closed(discountStart, NOW - 10 * DAY, -500),
      closed(premiumStart, NOW - 5 * DAY, 400),
    ];
    const recency = (startedAt: number) => 1 / (1 + (NOW - startedAt) / (365.25 * DAY));
    const severityPenalty =
      Math.max((500 / 100) * (10 / 30) * recency(discountStart), (500 / 2000) * recency(discountStart)) +
      0.25 * Math.max((400 / 100) * (10 / 30) * recency(premiumStart), (400 / 2000) * recency(premiumStart));
    // The union covers days 0-15: 10 discount days plus 5 premium-only days.
    const weightedOffPegSec = 10 * DAY + 0.25 * 5 * DAY;
    const weightedPegPct = (1 - weightedOffPegSec / (20 * DAY)) * 100;
    expect(weightedPegPct).toBe(43.75);
    expect(computePremiumWeightedPegScore(events, start, NOW, 0.25)).toBe(
      Math.round(0.5 * weightedPegPct + 0.5 * (100 - severityPenalty)),
    );
  });

  it.each([Number.POSITIVE_INFINITY, Number.NaN])(
    "keeps a non-finite peak (%s) at full weight in time",
    (peakDeviationBps) => {
      const events = [closed(NOW - 10 * DAY, NOW - 5 * DAY, peakDeviationBps)];
      const pegPct = (1 - (5 * DAY) / (365 * DAY)) * 100;
      // Not provably a premium: the 5-day off-peg span counts in full, with no
      // severity or spread penalty because the magnitude itself is unreadable.
      expect(computePremiumWeightedPegScore(events, START, NOW, 0.25)).toBe(
        Math.round(0.5 * pegPct + 50),
      );
    },
  );

  it("leaves the below-only spread penalty unchanged", () => {
    const start = NOW - 100 * DAY;
    const events = [
      closed(NOW - 60 * DAY, NOW - 50 * DAY, -100),
      closed(NOW - 40 * DAY, NOW - 30 * DAY, -900),
      closed(NOW - 20 * DAY, NOW - 18 * DAY, 800),
      closed(NOW - 10 * DAY, NOW - 9 * DAY, 300),
    ];
    expect(computePegScore(events, start, NOW).spreadPenalty).toBeCloseTo(6, 10);

    const expected = (premiumWeight: number) => {
      let totalSec = 0;
      let belowSec = 0;
      let totalPenalty = 0;
      for (const event of events) {
        const seconds = (event.endedAt ?? NOW) - Math.max(event.startedAt, start);
        totalSec += seconds;
        if (event.peakDeviationBps <= 0) belowSec += seconds;
        const peakBps = Math.abs(event.peakDeviationBps);
        const durationDays = Math.min(seconds / DAY, 90);
        const recency = 1 / (1 + (NOW - event.startedAt) / (365.25 * DAY));
        totalPenalty += Math.max((peakBps / 100) * (durationDays / 30) * recency, (peakBps / 2000) * recency)
          * (event.peakDeviationBps > 0 ? premiumWeight : 1);
      }
      const weightedPct = Math.max(0, (1 - (belowSec + premiumWeight * (totalSec - belowSec)) / (NOW - start)) * 100);
      const severity = Math.max(0, 100 - totalPenalty);
      return Math.round(Math.max(0, Math.min(100, 0.5 * weightedPct + 0.5 * severity - 6)));
    };

    expect(computePremiumWeightedPegScore(events, start, NOW, 0.25)).toBe(expected(0.25));
  });

  it("scales the whole capped active penalty for a premium, not only its slope", () => {
    // Unweighted, any active peak of 2,500 bps or more costs the 50-point cap; a
    // premium costs `premiumWeight` of that capped penalty (12.5 at 0.25).
    const expected = (peakBps: number, premiumWeight: number) => {
      const days = 1;
      const recency = 1 / (1 + days / 365.25);
      const severityPenalty = Math.max((peakBps / 100) * (days / 30) * recency, (peakBps / 2000) * recency) * premiumWeight;
      const pegPct = (1 - (premiumWeight * days * DAY) / (365 * DAY)) * 100;
      const activePenalty = Math.min(50, Math.max(5, peakBps / 50)) * premiumWeight;
      return Math.round(0.5 * pegPct + 0.5 * (100 - severityPenalty) - activePenalty);
    };
    for (const peakBps of [5_000, 10_000]) {
      const events = [active(NOW - DAY, peakBps)];
      expect(computePremiumWeightedPegScore(events, START, NOW, 0.25)).toBe(expected(peakBps, 0.25));
      expect(computePremiumWeightedPegScore(events, START, NOW, 1)).toBe(computePegScore(events, START, NOW).pegScore);
    }
    expect(expected(5_000, 0.25)).toBe(87);
  });

  it("returns null exactly when the public score is null", () => {
    expect(computePremiumWeightedPegScore([], null, NOW, 0.25)).toBeNull();
    expect(computePremiumWeightedPegScore([closed(NOW - 2 * DAY, NOW - DAY, -900)], NOW - 3 * DAY, NOW, 0.25)).toBeNull();
  });

  it("accepts the inclusive weight bounds", () => {
    expect(computePremiumWeightedPegScore([], START, NOW, 0)).toBe(100);
    expect(computePremiumWeightedPegScore([], START, NOW, 1)).toBe(100);
  });

  it.each([-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "throws RangeError for weight %s",
    (premiumWeight) => {
      expect(() => computePremiumWeightedPegScore([], START, NOW, premiumWeight)).toThrow(RangeError);
    },
  );
});
