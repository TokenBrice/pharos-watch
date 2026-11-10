import { describe, expect, it } from "vitest";

import { COLLIDING_DEPEG_EVENT_SLUGS, DEPEG_EVENT_ENTRIES } from "@/lib/depeg-event-page-data";
import {
  buildDepegEventDescription,
  buildDepegEventSynopsis,
  buildDepegEventTitle,
  formatEventNavigationLabel,
} from "@/lib/depeg-event-display";
import { formatDeviationBps, formatLongDate } from "@shared/lib/format";
import type { DepegEventDisplayInput } from "@/lib/depeg-event-display";
import { DepegEventSchema } from "@shared/types/market";
import { classifyDepegClosure, type DepegClosureInput } from "@shared/lib/depeg-closure";

const GYD_MARCH_19 = DEPEG_EVENT_ENTRIES.filter((event) => event.slug.startsWith("gyd-2026-03-19-down-"));

describe("depeg event collision display", () => {
  it("assigns unique search titles, descriptions, and visible synopses to the GYD collision group", () => {
    // The roster is live registry data; a collision group needs at least two members.
    expect(GYD_MARCH_19.length).toBeGreaterThan(1);
    expect(GYD_MARCH_19.every((event) => COLLIDING_DEPEG_EVENT_SLUGS.has(event.slug))).toBe(true);

    const titles = GYD_MARCH_19.map((event) => buildDepegEventTitle(event, true));
    const descriptions = GYD_MARCH_19.map((event) => buildDepegEventDescription(event, true));
    const synopses = GYD_MARCH_19.map((event) => buildDepegEventSynopsis(event));

    expect(new Set(titles).size).toBe(GYD_MARCH_19.length);
    expect(new Set(descriptions).size).toBe(GYD_MARCH_19.length);
    expect(new Set(synopses).size).toBe(GYD_MARCH_19.length);
    expect(titles.every((title) => `${title} | Pharos`.length <= 70)).toBe(true);
    expect(descriptions.every((description) => description.length >= 110 && description.length <= 180)).toBe(true);
  });

  it("exposes precise UTC identity in the formerly consolidated URLs and adjacent navigation", () => {
    // Long-style durations as the synopsis renders them, derived from each event's own clocks.
    const longDuration = (seconds: number) => {
      const minutes = Math.round(seconds / 60);
      if (minutes < 60) return `${minutes} min`;
      const hours = minutes / 60;
      return hours < 24 ? `${hours.toFixed(1)} hr` : `${(hours / 24).toFixed(1)} days`;
    };
    for (const event of GYD_MARCH_19) {
      const startIso = new Date(event.startedAt * 1000).toISOString();
      const startTime = `${startIso.slice(11, 16)} UTC`;
      expect(buildDepegEventTitle(event, true), event.slug).toContain(`at ${startTime}`);
      expect(buildDepegEventDescription(event, true), event.slug).toContain(`at ${startTime}`);
      const synopsis = buildDepegEventSynopsis(event);
      expect(synopsis, event.slug).toContain(`at ${startTime}`);
      expect(formatEventNavigationLabel(event, true), event.slug).toBe(
        `${event.symbol} ${startIso.slice(0, 10)} ${startTime}`,
      );
      if (event.endedAt != null) {
        const endIso = new Date(event.endedAt * 1000).toISOString();
        expect(synopsis, event.slug).toContain(
          `after ${longDuration(event.endedAt - event.startedAt)} at ${endIso.slice(11, 16)} UTC`,
        );
      }
    }
  });

});

describe("depeg event search title and description", () => {
  const usdc: DepegEventDisplayInput = {
    stablecoinId: "usdc-circle", symbol: "USDC", slug: "title-fixture", pegType: "peggedUSD",
    direction: "below", peakDeviationBps: -1210, startedAt: Date.parse("2023-03-11T03:00:00Z") / 1000,
    endedAt: Date.parse("2023-03-13T03:00:00Z") / 1000, peakPrice: 0.879, recoveryPrice: 1, pegReference: 1, closeReason: "recovered-primary",
  };

  it("leads with the symbol, date and deviation, without a clause dash", () => {
    expect(buildDepegEventTitle(usdc, false)).toBe("USDC Depeg, March 11, 2023: 12.1% Below Peg");
    expect(buildDepegEventTitle({ ...usdc, direction: "above", peakDeviationBps: 2100 }, false)).toBe(
      "USDC Depeg, March 11, 2023: 21.0% Above Peg",
    );
    expect(buildDepegEventTitle(usdc, false)).not.toMatch(/[‒-―]/);
  });

  it("omits an unavailable deviation instead of printing a placeholder", () => {
    const title = buildDepegEventTitle({ ...usdc, peakDeviationBps: 0 }, false);
    expect(title).toBe("USDC Depeg, March 11, 2023: Below Peg");
    expect(buildDepegEventDescription({ ...usdc, peakDeviationBps: 0 }, false, "USD Coin")).toMatch(
      /^USD Coin \(USDC\) fell below its peg on March 11, 2023\./,
    );
  });

  it("opens the description with the coin name, symbol, deviation and date", () => {
    expect(buildDepegEventDescription(usdc, false, "USD Coin")).toMatch(
      /^USD Coin \(USDC\) fell 12\.1% below its peg on March 11, 2023\. Recovered after /,
    );
    expect(buildDepegEventDescription({ ...usdc, direction: "above", peakDeviationBps: 300 }, false, "USDC")).toMatch(
      /^USDC rose 3\.00% above its peg on March 11, 2023\./,
    );
    expect(buildDepegEventDescription(usdc, true, null)).toMatch(/^USDC fell 12\.1% below its peg at 03:00 UTC on March 11, 2023\./);
  });

  it("renders the synopsis prices in the peg's native unit", () => {
    const eurc: DepegEventDisplayInput = {
      ...usdc,
      symbol: "EURC",
      pegType: "peggedEUR",
      pegReference: 1.17,
      peakPrice: 1.05,
      recoveryPrice: 1.17,
    };
    const synopsis = buildDepegEventSynopsis(eurc);
    expect(synopsis).toContain("at €0.8974");
    expect(synopsis).toContain("€1.00");
    expect(synopsis).not.toContain("$1.05");
  });

  it("qualifies a disputed audit verdict without dropping the measured deviation", async () => {
    const event = DEPEG_EVENT_ENTRIES.find((entry) => entry.provenance?.auditVerdict === "disputed")!;
    expect(event).toBeDefined();
    const deviation = formatDeviationBps(event.peakDeviationBps);
    const longDate = formatLongDate(new Date(event.startedAt * 1000), { utc: true });

    expect(buildDepegEventTitle(event, false)).toBe(
      `${event.symbol} Depeg, ${longDate}: ${deviation} Above Peg (Disputed)`,
    );
    expect(buildDepegEventDescription(event, false)).toContain(`rose ${deviation} above its peg (Disputed)`);
    expect(buildDepegEventSynopsis(event)).toContain(`${deviation} (Disputed)`);
  });

  it("qualifies exactly the disputed archive events", () => {
    for (const event of DEPEG_EVENT_ENTRIES) {
      const disputed = event.provenance?.auditVerdict === "disputed" || event.provenance?.auditVerdict === "false_positive";
      const texts = [
        buildDepegEventTitle(event, false),
        buildDepegEventDescription(event, false),
        buildDepegEventSynopsis(event),
      ];
      for (const text of texts) expect(text.includes("(Disputed)"), event.slug).toBe(disputed);
    }
  });
});

describe("depeg closure presentation", () => {
  const base: DepegEventDisplayInput = {
    stablecoinId: "usdc-circle", symbol: "USDC", slug: "closure-fixture", pegType: "peggedUSD",
    direction: "below", peakDeviationBps: -500, startedAt: 1_700_000_000,
    endedAt: 1_700_003_600, peakPrice: 0.95, recoveryPrice: 1, pegReference: 1, closeReason: null,
  };

  it.each([
    ["recovered-primary", 1, true, /recovered/i],
    ["recovered-dex", null, true, /recovered/i],
    ["recovered-native", 1, true, /recovered/i],
    [null, 1, true, /recovered/i],
    ["coverage-lost-supply", 1, false, /coverage lost/i],
    ["superseded-direction", 1, false, /direction superseded/i],
    ["orphan-tracking-removed", 1, false, /asset removed/i],
    [null, null, false, /recovery unconfirmed/i],
  ] as const)("keeps closure %s distinct from recovery in every description form", (closeReason, recoveryPrice, recovered, outcome) => {
    const event: DepegEventDisplayInput = { ...base, closeReason, recoveryPrice };
    for (const text of [
      buildDepegEventDescription(event, false),
      buildDepegEventDescription(event, true),
      buildDepegEventSynopsis(event),
    ]) {
      expect(text).toMatch(outcome);
      expect(/\brecovered\b/i.test(text)).toBe(recovered);
      if (!recovered) expect(text).not.toContain("$1.00");
    }
  });

  it("keeps an open observation ongoing even if recovery fields are present", () => {
    const event: DepegEventDisplayInput = { ...base, endedAt: null, closeReason: "recovered-primary" };
    for (const text of [buildDepegEventDescription(event, false), buildDepegEventDescription(event, true), buildDepegEventSynopsis(event)]) {
      expect(text).toMatch(/ongoing/i);
      expect(text).not.toMatch(/recovered|tracking closed/i);
    }
  });

  it.each(["unrecognized", "unknown-reason"])("rejects %s at the wire boundary and classifies raw closure evidence conservatively", (closeReason) => {
    // Raw classifier inputs may contain future reasons; validated display inputs cannot.
    const raw: DepegClosureInput = { endedAt: base.endedAt, closeReason, recoveryPrice: 1 };
    expect(classifyDepegClosure(raw)).toBe("unknown_closed");
    expect(DepegEventSchema.shape.closeReason.safeParse(closeReason).success).toBe(false);
  });

  it("classifies an omitted legacy reason as recovery only with recovery-price evidence", () => {
    expect(classifyDepegClosure({ endedAt: base.endedAt, recoveryPrice: 1 })).toBe("legacy_recovered");
    expect(classifyDepegClosure({ endedAt: base.endedAt, recoveryPrice: null })).toBe("unknown_closed");
  });
});
