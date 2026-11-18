import { describe, expect, it } from "vitest";

import { COLLIDING_DEPEG_EVENT_SLUGS, DEPEG_EVENT_ENTRIES } from "@/lib/depeg-event-page-data";
import { readDepegEventSnapshot } from "@/lib/depeg-event-snapshot";
import {
  buildDepegEventDescription,
  buildDepegEventSynopsis,
  buildDepegEventTitle,
  formatEventNavigationLabel,
  formatEventPrice,
  getDepegEventOnset,
} from "@/lib/depeg-event-display";
import { formatDeviationBps, formatLongDate } from "@shared/lib/format";
import type { DepegEventDisplayInput } from "@/lib/depeg-event-display";
import { DepegEventSchema, DepegEventStoredSnapshotSchema } from "@shared/types/peg";
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

  it("decodes the archived basis for a weekend EURC move and keeps its quotes in USD", () => {
    const [peer] = DepegEventStoredSnapshotSchema.parse([{
      id: 1, ...usdc, source: "live", stablecoinId: "eurc-circle", symbol: "EURC", pegType: "peggedEUR",
      startedAt: Date.parse("2026-11-14T12:00:00Z") / 1000, endedAt: null, recoveryPrice: null, closeReason: null,
      onsetBasis: "peer-relative", peakBasis: "peer-relative", peakPeerMedianUsd: 1.08,
      pegReference: 1.08, startPrice: 1.026, peakPrice: 1.026, peakDeviationBps: -500,
    }]);
    expect(buildDepegEventTitle(peer, false)).toContain("5.00% Below Peer Median (lower confidence)");
    expect(formatEventPrice(peer.pegReference, peer, "reference")).toBe("$1.0800 USD");
    expect(formatEventPrice(peer.startPrice, peer, "start")).toBe("$1.0260 USD");
    expect(formatEventPrice(peer.peakPrice, peer, "peak")).toBe("$1.0260 USD");
    expect(buildDepegEventSynopsis(peer)).toContain("moved below the peer median at 12:00 UTC");
  });

  it.each([
    [null, /Detector close recorded.*12:30 UTC.*Recovery is unverified/],
    [900, /Recovered.*12:15 UTC.*€1.00/],
    [undefined, /Recovered.*12:30 UTC.*€1.00/],
  ] as const)("decodes explicitly known, unknown and absent analytic recovery (%s)", (recoveryOffset, expected) => {
    const startedAt = Date.parse("2026-11-16T12:00:00Z") / 1000;
    const [event] = DepegEventStoredSnapshotSchema.parse([{
      id: 1, ...usdc, source: "live", stablecoinId: "eurs-stasis", symbol: "EURS", pegType: "peggedEUR",
      startedAt, endedAt: startedAt + 1800, startPrice: 1.026, pegReference: 1.08,
      recoveryPrice: 1.08, recoveryPegReference: 1.08,
      ...(recoveryOffset === undefined ? {} : { analyticRecoveryAt: recoveryOffset === null ? null : startedAt + recoveryOffset }),
      admittedCoverage: [{ fromSec: startedAt, toSec: startedAt + 900 }],
    }]);
    expect(buildDepegEventSynopsis(event)).toMatch(expected);
  });

  it("leads with the symbol, date and deviation, without a clause dash", () => {
    expect(buildDepegEventTitle(usdc, false)).toBe("USDC Depeg, March 11, 2023: 12.1% Below Peg");
    expect(buildDepegEventTitle({ ...usdc, direction: "above", peakDeviationBps: 2100 }, false)).toBe(
      "USDC Depeg, March 11, 2023: 21.0% Above Peg",
    );
    expect(buildDepegEventTitle(usdc, false)).not.toMatch(/[‒-―]/);
  });

  it.each([89169, 89170, 89172, 89173])("qualifies the reviewed BRZ peak on event %s", (id) => {
    const brz = { ...usdc, id, stablecoinId: "brz-transfero", symbol: "BRZ", pegType: "peggedBRL",
      direction: "above" as const, peakDeviationBps: 6156 };
    expect(buildDepegEventTitle(brz, false)).toContain("peak unverified");
    expect(buildDepegEventDescription(brz, false)).toContain("peak unverified");
    expect(buildDepegEventTitle(brz, false)).not.toContain("61.56%");
    expect(buildDepegEventSynopsis(brz)).toMatch(/61\.6%.*peak unverified/);
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

  it.each([
    [{ peakQuoteDomain: "usd", peakPegReference: 1.1, recoveryPegReference: 1.17 }, "€0.9545", "€1.00"],
    [{}, "$1.05 USD", "$1.17 USD"],
  ] as const)("renders prices using their own observed reference (%j)", (referenceFields, peak, recovery) => {
    const eurc: DepegEventDisplayInput = {
      ...usdc,
      symbol: "EURC",
      pegType: "peggedEUR",
      pegReference: 1.17,
      peakPrice: 1.05,
      recoveryPrice: 1.17,
      ...referenceFields,
    };
    const synopsis = buildDepegEventSynopsis(eurc);
    expect(synopsis).toContain(`at ${peak}`);
    expect(synopsis).toContain(recovery);
  });

  it.each([
    ["tryb-2026-07-13", "₺1.00", "₺0.8247"],
    ["eurs-2026-07-12", "€1.00", null],
  ])("labels recorded native par for %s", (slug, reference, peak) => {
    const event = DEPEG_EVENT_ENTRIES.find((entry) => entry.slug === slug)!;
    expect(formatEventPrice(event.pegReference, event, "reference")).toBe(reference);
    if (peak) expect(formatEventPrice(event.peakPrice, event, "peak")).toBe(peak);
  });

  it.each(["legacy", "empty", "annotated"] as const)("distinguishes recorded onset from %s admitted coverage", (coverage) => {
    const event = DEPEG_EVENT_ENTRIES.find((entry) => entry.id === 90187)!;
    const reopen = Date.parse("2026-06-14T23:00:00Z") / 1000;
    const first = coverage === "annotated" ? reopen + 300 : null;
    const admittedCoverage = coverage === "legacy" ? undefined : first == null ? [] : [{ fromSec: first, toSec: event.endedAt! }];
    const row = { ...event, admittedCoverage };
    expect(getDepegEventOnset(row)).toEqual({ firstAdmissible: first, qualified: true });
    expect(buildDepegEventTitle(row, false)).toContain("Depeg Recorded");
    const synopsis = buildDepegEventSynopsis(row);
    expect(synopsis).toContain("Detector start recorded on June 14, 2026 at 22:34 UTC");
    expect(synopsis).toContain(first == null ? "no admissible onset is documented" : "first admissible observation June 14, 2026 at 23:05 UTC");
    expect(synopsis).not.toContain("moved below peg at");
  });

  it("restores the native BRLA replay recovery while respecting an explicit close reason", () => {
    const event = readDepegEventSnapshot({ missing: "throw" }).find((row) => row.id === 90497)!;
    expect(formatEventPrice(event.recoveryPrice, event, "recovery")).toBe("R$0.9864");
    expect(formatEventPrice(event.recoveryPrice, { ...event, closeReason: "recovered-primary" }, "recovery")).toBe("$0.9864 USD");
  });

  it("does not use EURR's later severe peak as evidence of a closed-session onset", () => {
    const event = readDepegEventSnapshot({ missing: "throw" }).find((row) => row.id === 90024)!;
    expect(getDepegEventOnset(event)).toEqual({ firstAdmissible: null, qualified: true });
    expect(buildDepegEventSynopsis(event)).toContain("no admissible onset is documented");
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
