import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DepegEvent, DepegEventEntry } from "@shared/types/market";
import {
  assertStaticDepegArchivePreserved,
  assignSlugs,
  findMissingStaticDepegArchiveSlugs,
  preserveStaticDepegArchiveEntries,
  runDepegSync,
} from "../maintenance/sync-depeg-events";

const tempRoots: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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
    const published: DepegEventEntry = { ...event({ id: 1, peakDeviationBps: -800 }), slug: "usdc-2026-05-15" };
    const subthreshold: DepegEventEntry = {
      ...event({ id: 2, peakDeviationBps: -300, startedAt: Date.UTC(2026, 4, 16) / 1000 }),
      slug: "usdc-2026-05-16",
    };
    const replacement: DepegEventEntry = {
      ...event({ id: 3, peakDeviationBps: -300, startedAt: Date.UTC(2026, 4, 17) / 1000 }),
      slug: "usdc-2026-05-17",
    };

    expect(
      findMissingStaticDepegArchiveSlugs(
        [published, subthreshold],
        [subthreshold, replacement],
      ),
    ).toEqual([published.slug]);
    expect(() =>
      assertStaticDepegArchivePreserved(
        [published, subthreshold],
        [subthreshold, replacement],
      ),
    ).toThrow("Depeg static archive lost 1 published slug(s): usdc-2026-05-15");
  });

  it("allows subthreshold rows to disappear and supports an explicit reviewed override", () => {
    const subthreshold: DepegEventEntry = { ...event({ peakDeviationBps: -300 }), slug: "usdc-2026-05-15" };
    const published: DepegEventEntry = { ...event({ peakDeviationBps: -800 }), slug: "usdc-2026-05-15" };

    expect(() => assertStaticDepegArchivePreserved([subthreshold], [])).not.toThrow();
    expect(() => assertStaticDepegArchivePreserved([published], [], true)).not.toThrow();
  });

  it("carries a published row forward when the live record becomes subthreshold", () => {
    const published: DepegEventEntry = { ...event({ id: 1, peakDeviationBps: -800 }), slug: "usdc-2026-05-15" };
    const reclassified: DepegEventEntry = { ...event({ id: 2, peakDeviationBps: -129 }), slug: "usdc-2026-05-15" };
    const replacement: DepegEventEntry = {
      ...event({ id: 3, peakDeviationBps: -600, startedAt: Date.UTC(2026, 4, 16) / 1000 }),
      slug: "usdc-2026-05-16",
    };

    const merged = preserveStaticDepegArchiveEntries(
      [published],
      [reclassified, replacement],
    );

    expect(merged.find((entry) => entry.slug === published.slug)).toMatchObject({
      id: published.id,
      peakDeviationBps: published.peakDeviationBps,
    });
    expect(findMissingStaticDepegArchiveSlugs([published], merged)).toEqual([]);
    expect(() => assertStaticDepegArchivePreserved([published], merged)).not.toThrow();
  });

  it("writes full UTC-year shards and changes only the affected shard for a new event", async () => {
    const root = mkdtempSync(join(tmpdir(), "depeg-event-shards-test-"));
    tempRoots.push(root);
    const indexPath = join(root, "data/depeg-events/index.json");
    const older = event({ id: 1, peakDeviationBps: 300, startedAt: Date.UTC(2025, 4, 15) / 1000 });
    const current = event({ id: 2, peakDeviationBps: 800, startedAt: Date.UTC(2026, 4, 15) / 1000 });
    let apiEvents: DepegEvent[] = [older, current];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ events: apiEvents }), { status: 200 }))),
    );

    await runDepegSync(["--api-url", "https://api.example.test", "--output", indexPath]);
    const olderShardPath = join(root, "data/depeg-events/2025.json");
    const currentShardPath = join(root, "data/depeg-events/2026.json");
    const olderShardBefore = readFileSync(olderShardPath, "utf8");
    const currentShardBefore = readFileSync(currentShardPath, "utf8");
    const indexBefore = readFileSync(indexPath, "utf8");

    apiEvents = [
      ...apiEvents,
      event({ id: 3, peakDeviationBps: 900, startedAt: Date.UTC(2026, 5, 17) / 1000 }),
    ];
    await runDepegSync(["--api-url", "https://api.example.test", "--output", indexPath]);

    expect(readFileSync(olderShardPath, "utf8")).toBe(olderShardBefore);
    expect(readFileSync(currentShardPath, "utf8")).not.toBe(currentShardBefore);
    expect(readFileSync(indexPath, "utf8")).not.toBe(indexBefore);
    expect(JSON.parse(readFileSync(olderShardPath, "utf8"))).toHaveLength(1);
    expect(JSON.parse(readFileSync(currentShardPath, "utf8"))).toHaveLength(2);
    expect(JSON.parse(readFileSync(indexPath, "utf8"))).toHaveLength(2);
  });
});
