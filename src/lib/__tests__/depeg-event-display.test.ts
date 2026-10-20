import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { COLLIDING_DEPEG_EVENT_SLUGS, DEPEG_EVENT_ENTRIES } from "@/lib/depeg-event-page-data";
import {
  buildDepegEventDescription,
  buildDepegEventSynopsis,
  buildDepegEventTitle,
  formatEventNavigationLabel,
} from "@/lib/depeg-event-display";
import DepegEventPage, { generateMetadata } from "@/app/depeg/[event]/page";
import type { DepegEventDisplayInput } from "@/lib/depeg-event-display";
import { DepegEventSchema } from "@shared/types/market";
import { classifyDepegClosure, type DepegClosureInput } from "@shared/lib/depeg-closure";

vi.mock("@/lib/fonts/digest", () => ({ digestDisplay: { className: "" } }));

const GYD_MARCH_19 = DEPEG_EVENT_ENTRIES.filter((event) => event.slug.startsWith("gyd-2026-03-19-down-"));

describe("depeg event collision display", () => {
  it("assigns unique search titles, descriptions, and visible synopses to the GYD collision group", () => {
    expect(GYD_MARCH_19).toHaveLength(13);
    expect(GYD_MARCH_19.every((event) => COLLIDING_DEPEG_EVENT_SLUGS.has(event.slug))).toBe(true);

    const titles = GYD_MARCH_19.map((event) => buildDepegEventTitle(event, null, true));
    const descriptions = GYD_MARCH_19.map((event) => buildDepegEventDescription(event, true));
    const synopses = GYD_MARCH_19.map((event) => buildDepegEventSynopsis(event));

    expect(new Set(titles).size).toBe(GYD_MARCH_19.length);
    expect(new Set(descriptions).size).toBe(GYD_MARCH_19.length);
    expect(new Set(synopses).size).toBe(GYD_MARCH_19.length);
    expect(titles.every((title) => `${title} | Pharos`.length <= 70)).toBe(true);
    expect(descriptions.every((description) => description.length >= 110 && description.length <= 180)).toBe(true);
  });

  it("exposes precise UTC identity in the formerly consolidated URLs and adjacent navigation", () => {
    const event = GYD_MARCH_19.find((candidate) => candidate.slug.endsWith("87904"));
    expect(event).toBeDefined();

    expect(buildDepegEventTitle(event!, null, true)).toContain("March 19, 2026 at 14:30 UTC");
    expect(buildDepegEventDescription(event!, true)).toContain("at 14:30 UTC");
    expect(buildDepegEventSynopsis(event!)).toMatch(/Recovered after 45 min.*15:15 UTC/);
    expect(formatEventNavigationLabel(event!, true)).toBe("GYD 2026-03-19 14:30 UTC");
  });

});

describe("depeg closure presentation", () => {
  const base: DepegEventDisplayInput = {
    stablecoinId: "usdc-circle", symbol: "USDC", slug: "closure-fixture",
    direction: "below", peakDeviationBps: -500, startedAt: 1_700_000_000,
    endedAt: 1_700_003_600, peakPrice: 0.95, recoveryPrice: 1, closeReason: null,
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

  it.each(["tryb-2026-06-23", "usdr-2026-06-21"])("uses the same coverage-loss description in metadata and JSON-LD for %s", async (slug) => {
    const event = DEPEG_EVENT_ENTRIES.find((entry) => entry.slug === slug)!;
    const params = Promise.resolve({ event: slug });
    const metadata = await generateMetadata({ params });
    const description = buildDepegEventDescription(event, COLLIDING_DEPEG_EVENT_SLUGS.has(slug));
    expect(metadata.description).toBe(description);
    expect(metadata.openGraph).toMatchObject({ description });
    expect(description).toMatch(/coverage lost/i);
    expect(description).not.toMatch(/\brecovered\b/i);
    const html = renderToStaticMarkup(await DepegEventPage({ params }));
    const articles = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map((match) => JSON.parse(match[1]))
      .filter((entry) => entry["@type"] === "NewsArticle");
    expect(articles).toHaveLength(1);
    expect(articles[0].description).toBe(description);
    expect(html).toContain(buildDepegEventSynopsis(event));
  });
});

describe("depeg event editorial rendering", () => {
  it.each([
    ["usdc-2023-03-11", true],
    ["tryb-2026-06-23", false],
  ] as const)("renders a briefing only for authored event %s", async (slug, authored) => {
    const html = renderToStaticMarkup(await DepegEventPage({ params: Promise.resolve({ event: slug }) }));
    expect(/<article aria-label="[^"]+ depeg briefing"/.test(html)).toBe(authored);
  });
});
