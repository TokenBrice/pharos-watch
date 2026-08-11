import { describe, expect, it } from "vitest";
import type { DepegEvent } from "@shared/types/market";
import {
  assertStaticDepegArchivePreserved,
  assignSlugs,
  findMissingStaticDepegArchiveSlugs,
  preserveStaticDepegArchiveEntries,
  type DepegEventEntry,
} from "../maintenance/sync-depeg-events";

function event(overrides: Partial<DepegEvent> = {}): DepegEvent {
  return {
    id: 1,
    stablecoinId: "usdc-circle",
    symbol: "USDC",
    pegType: "USD",
    direction: "below",
    peakDeviationBps: 300,
    startedAt: Date.UTC(2026, 4, 15) / 1000,
    endedAt: null,
    startPrice: 1,
    peakPrice: 0.97,
    recoveryPrice: null,
    pegReference: 1,
    source: "live",
    confirmationSources: "CoinGecko",
    pendingReason: null,
    closeReason: null,
    provenance: null,
    ...overrides,
  };
}

describe("sync-depeg-events", () => {
  it("assigns deterministic slugs for same-coin same-day events", () => {
    const entries = assignSlugs([event({ id: 2, direction: "above" }), event({ id: 1, direction: "below" })]);

    expect(entries.map((entry) => entry.slug)).toEqual(["usdc-2026-05-15-up", "usdc-2026-05-15-down"]);
  });

  it("refuses to remove a published static event even when total event count grows", () => {
    const published = { ...event({ id: 1, peakDeviationBps: -800 }), slug: "usdc-2026-05-15" };
    const subthreshold = {
      ...event({ id: 2, peakDeviationBps: -300, startedAt: Date.UTC(2026, 4, 16) / 1000 }),
      slug: "usdc-2026-05-16",
    };
    const replacement = {
      ...event({ id: 3, peakDeviationBps: -300, startedAt: Date.UTC(2026, 4, 17) / 1000 }),
      slug: "usdc-2026-05-17",
    };

    expect(
      findMissingStaticDepegArchiveSlugs(
        [published, subthreshold] as DepegEventEntry[],
        [subthreshold, replacement] as DepegEventEntry[],
      ),
    ).toEqual([published.slug]);
    expect(() =>
      assertStaticDepegArchivePreserved(
        [published, subthreshold] as DepegEventEntry[],
        [subthreshold, replacement] as DepegEventEntry[],
      ),
    ).toThrow("Depeg static archive lost 1 published slug(s): usdc-2026-05-15");
  });

  it("allows subthreshold rows to disappear and supports an explicit reviewed override", () => {
    const subthreshold = { ...event({ peakDeviationBps: -300 }), slug: "usdc-2026-05-15" };
    const published = { ...event({ peakDeviationBps: -800 }), slug: "usdc-2026-05-15" };

    expect(() => assertStaticDepegArchivePreserved([subthreshold] as DepegEventEntry[], [])).not.toThrow();
    expect(() => assertStaticDepegArchivePreserved([published] as DepegEventEntry[], [], true)).not.toThrow();
  });

  it("carries a published row forward when the live record becomes subthreshold", () => {
    const published = { ...event({ id: 1, peakDeviationBps: -800 }), slug: "usdc-2026-05-15" };
    const reclassified = { ...event({ id: 2, peakDeviationBps: -129 }), slug: "usdc-2026-05-15" };
    const replacement = {
      ...event({ id: 3, peakDeviationBps: -600, startedAt: Date.UTC(2026, 4, 16) / 1000 }),
      slug: "usdc-2026-05-16",
    };

    const merged = preserveStaticDepegArchiveEntries(
      [published] as DepegEventEntry[],
      [reclassified, replacement] as DepegEventEntry[],
    );

    expect(merged.find((entry) => entry.slug === published.slug)).toMatchObject({
      id: published.id,
      peakDeviationBps: published.peakDeviationBps,
    });
    expect(findMissingStaticDepegArchiveSlugs([published] as DepegEventEntry[], merged)).toEqual([]);
    expect(() => assertStaticDepegArchivePreserved([published] as DepegEventEntry[], merged)).not.toThrow();
  });
});
