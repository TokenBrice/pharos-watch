import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { makeYieldRanking } from "@shared/test-utils/yield-ranking-fixtures";
import { makeAsset } from "../../../test-helpers/__shared/fixtures";
import { OG_PAGE_LOADERS } from "../index";
import type { OgPageLoad } from "../types";

/**
 * Real owner handlers over the migrated D1 schema, read through the real
 * `readOwnerJson` and published response schemas. A body the schema rejects
 * would make a card permanently timeless with reason `owner-error`; these
 * tests fail on that instead of mocking the parse away.
 */

const NOW = 1_790_000_000;

function seedCache(sqlite: ReturnType<typeof createLatestSchemaSqlite>["sqlite"], key: string, value: unknown, updatedAt = NOW - 60) {
  sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(key, JSON.stringify(value), updatedAt);
}

function seedStablecoins(sqlite: ReturnType<typeof createLatestSchemaSqlite>["sqlite"]) {
  seedCache(sqlite, "stablecoins", {
    peggedAssets: CLIENT_ACTIVE_STABLECOINS.map((meta) => makeAsset({
      id: meta.id, symbol: meta.symbol, name: meta.name, circulating: { peggedUSD: 1_000_000 },
      chainCirculating: { Ethereum: { current: 1_000_000, circulatingPrevDay: 1_000_000, circulatingPrevWeek: 1_000_000, circulatingPrevMonth: 1_000_000 } },
      chains: ["Ethereum"],
    })),
  });
}

function expectParsedByOwnerSchema(load: OgPageLoad) {
  expect(load).not.toEqual({ kind: "unavailable", reason: "owner-error" });
}

describe("route-card loaders over real owner bodies", () => {
  let fixture: ReturnType<typeof createLatestSchemaSqlite>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    fixture = createLatestSchemaSqlite();
  });

  afterEach(() => {
    fixture.sqlite.close();
    vi.useRealTimers();
  });

  it("chains, timeline and home publish from real /api/chains and /api/peg-summary bodies", async () => {
    seedStablecoins(fixture.sqlite);
    for (const slug of ["chains", "timeline", "home", "freezewatch"] as const) {
      const load = await OG_PAGE_LOADERS[slug](fixture.db, NOW);
      expectParsedByOwnerSchema(load);
      expect(load.kind, slug).toBe("ok");
    }
  });

  it("yield publishes from a real summary-projection body", async () => {
    seedCache(fixture.sqlite, "yield-rankings", {
      rankings: [makeYieldRanking()],
      riskFreeRate: 4.25,
      scalingFactor: 8,
      medianApy: 5,
      updatedAt: NOW - 60,
      publication: { generationId: `yield-${NOW - 60}`, updatedAt: NOW - 60, cutoffAt: NOW - 60, schemaVersion: 1, status: "published" },
    });
    const load = await OG_PAGE_LOADERS.yield(fixture.db, NOW);
    expectParsedByOwnerSchema(load);
    expect(load).toMatchObject({ kind: "ok", hero: "1" });
  });

  it("flows and liquidity bodies pass their schemas even with no observations", async () => {
    seedStablecoins(fixture.sqlite);
    expectParsedByOwnerSchema(await OG_PAGE_LOADERS.flows(fixture.db, NOW));
    // No global DEX row is published: unavailable figure, not a schema failure or a $0 card.
    await expect(OG_PAGE_LOADERS.liquidity(fixture.db, NOW)).resolves.toEqual({ kind: "unavailable", reason: "figure-null" });
  });
});
