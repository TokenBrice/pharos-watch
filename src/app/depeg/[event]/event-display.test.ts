import { describe, expect, it } from "vitest";

import { COLLIDING_DEPEG_EVENT_SLUGS, DEPEG_EVENT_ENTRIES } from "./page-data";
import {
  buildDepegEventDescription,
  buildDepegEventSynopsis,
  buildDepegEventTitle,
  formatEventNavigationLabel,
} from "./event-display";

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
    expect(buildDepegEventSynopsis(event!)).toContain("closed 45 min later at 15:15 UTC");
    expect(formatEventNavigationLabel(event!, true)).toBe("GYD 2026-03-19 14:30 UTC");
  });

  it("keeps the concise date-only title for an event without a route collision", () => {
    const event = DEPEG_EVENT_ENTRIES.find((candidate) => !COLLIDING_DEPEG_EVENT_SLUGS.has(candidate.slug));
    expect(event).toBeDefined();

    expect(buildDepegEventTitle(event!, null, false)).not.toContain("UTC");
  });

  it("falls back to the symbol when a collision title would exceed the search envelope", () => {
    const event = GYD_MARCH_19[0];
    expect(event).toBeDefined();

    const title = buildDepegEventTitle(event!, "An Intentionally Long Stablecoin Product Name For Metadata", true);
    expect(title.startsWith("GYD depeg")).toBe(true);
    expect(`${title} | Pharos`.length).toBeLessThanOrEqual(70);
  });
});
