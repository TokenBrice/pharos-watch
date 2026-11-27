import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import type { PegSummaryCoin } from "@shared/types/peg";
import * as cache from "../db-cache";
import { loadPegAnalyticsCache, publishPegAnalyticsCache } from "../peg-analytics-cache";
import { getCacheJsonParseFailureCountersForTests, resetCacheJsonParseFailureCountersForTests } from "../api-cache-read";

const NOW_SEC = 1_783_891_200;
const TODAY_START_SEC = Math.floor(NOW_SEC / DAY_SECONDS) * DAY_SECONDS;
const pegRow = {
  id: "usdt-tether", symbol: "USDT", name: "Tether", pegType: "peggedUSD", pegCurrency: "USD", governance: "centralized",
  currentDeviationBps: 0, pegScore: 99, pegPct: 99.9, severityScore: 7, spreadPenalty: 2, eventCount: 1,
  worstDeviationBps: -120, activeDepeg: false, lastEventAt: NOW_SEC - DAY_SECONDS, trackingSpanDays: 400, methodologyVersion: "6.08",
} satisfies PegSummaryCoin;

const validPayload = (computedAtSec = NOW_SEC, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ computedAtSec, depegEventsToday: 0, depegEventsYesterday: 0, pegData: [pegRow], ...extra });

const snapshot = (allEvents: Array<{ stablecoinId: string; startedAt: number; provenance?: { auditVerdict: string } | null }>, nowSec = NOW_SEC) =>
  ({ nowSec, allEvents: allEvents as never, pegDataById: new Map([["usdt-tether", pegRow]]) });

describe("publishPegAnalyticsCache", () => {
  let db: D1Database;
  let sqlite: ReturnType<typeof createLatestSchemaSqlite>["sqlite"];
  const seedCache = (value: string, updatedAt = NOW_SEC) => cache.setCachesAt(db, [{ key: "peg-analytics", value }], updatedAt);

  beforeEach(() => { resetCacheJsonParseFailureCountersForTests(); ({ db, sqlite } = createLatestSchemaSqlite()); });
  afterEach(() => { sqlite.close(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it("counts today's and yesterday's depeg events and excludes NAV tokens and reviewed disputes", async () => {
    const published = await publishPegAnalyticsCache(db, snapshot([
      { stablecoinId: "usdt-tether", startedAt: TODAY_START_SEC + 60 },
      { stablecoinId: "usdt-tether", startedAt: TODAY_START_SEC - 60 },
      { stablecoinId: "usdt-tether", startedAt: TODAY_START_SEC - DAY_SECONDS - 60 },
      { stablecoinId: "scrvusd-curve", startedAt: TODAY_START_SEC + 60 },
      { stablecoinId: "usdt-tether", startedAt: TODAY_START_SEC + 120, provenance: { auditVerdict: "disputed" } },
      { stablecoinId: "usdt-tether", startedAt: TODAY_START_SEC - 120, provenance: { auditVerdict: "false_positive" } },
      { stablecoinId: "usdt-tether", startedAt: TODAY_START_SEC + 180, provenance: null },
    ]));
    expect(published).toBe(true);
    const row = sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = 'peg-analytics'").get()!;
    expect(row.updated_at).toBe(NOW_SEC);
    expect(JSON.parse(row.value as string)).toEqual({ computedAtSec: NOW_SEC, depegEventsToday: 2, depegEventsYesterday: 1, pegData: [pegRow] });
  });

  it("keeps a newer snapshot when an older run publishes late", async () => {
    for (const ts of [NOW_SEC, NOW_SEC + 900, NOW_SEC]) await publishPegAnalyticsCache(db, snapshot([], ts));
    const loaded = await loadPegAnalyticsCache(db, { maxAgeMs: Number.MAX_SAFE_INTEGER });
    expect(loaded).toMatchObject({ kind: "ok", payload: { computedAtSec: NOW_SEC + 900 } });
  });

  it("handles malformed JSON, write failure, and legacy invalid coin shapes", async () => {
    await seedCache("{bad-json");
    await expect(loadPegAnalyticsCache(db, { maxAgeMs: Number.MAX_SAFE_INTEGER })).resolves.toEqual({ kind: "miss", reason: "json-parse-failed" });
    expect(getCacheJsonParseFailureCountersForTests()["peg-analytics:peg-analytics"]?.count).toBe(1);

    await seedCache(JSON.stringify({ computedAtSec: NOW_SEC, depegEventsToday: 0, depegEventsYesterday: 0, pegData: [{ id: "usdt-tether" }] }));
    await expect(loadPegAnalyticsCache(db, { maxAgeMs: Number.MAX_SAFE_INTEGER })).resolves.toEqual({ kind: "miss", reason: "invalid-payload" });

    vi.spyOn(cache, "setCacheIfNewer").mockRejectedValue(new Error("d1 unavailable"));
    await expect(publishPegAnalyticsCache(db, snapshot([]))).resolves.toBe(false);
  });

  it("rejects day-scoped counters published on a previous UTC day", async () => {
    const publishedAtSec = Date.parse("2026-07-12T23:46:00Z") / 1000;
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-07-13T00:05:00Z"));
    await seedCache(validPayload(publishedAtSec), publishedAtSec);
    await expect(loadPegAnalyticsCache(db, { requireCurrentUtcDay: true })).resolves.toEqual({ kind: "miss", reason: "stale-day" });
    await expect(loadPegAnalyticsCache(db, { maxAgeMs: Infinity })).resolves.toMatchObject({ kind: "ok" });
  });

  it.each(["read", "write"])("unblocks publication of a future-dated row during %s recovery", async (mode) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
    await seedCache(validPayload(), NOW_SEC + DAY_SECONDS);
    if (mode === "read") {
      await expect(loadPegAnalyticsCache(db, { maxAgeMs: Infinity })).resolves.toEqual({ kind: "miss", reason: "future-timestamp" });
      expect(await cache.getCache(db, "peg-analytics")).toBeNull();
    }
    await expect(publishPegAnalyticsCache(db, snapshot([]))).resolves.toBe(true);
    expect((await cache.getCache(db, "peg-analytics"))?.updatedAt).toBe(NOW_SEC);
  });

  it.each([["read", "value"], ["read", "clock"], ["write", "value"], ["write", "clock"]])(
    "preserves replacements during %s recovery when only %s changes",
    async (mode, changed) => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW_SEC * 1000);
      const value = validPayload(NOW_SEC + 30);
      const futureSec = NOW_SEC + DAY_SECONDS;
      await seedCache(value, futureSec);
      const replacement = {
        value: changed === "value" ? validPayload(NOW_SEC + 60) : value,
        updatedAt: changed === "clock" ? NOW_SEC + 30 : futureSec,
      };
      const getCache = cache.getCache;
      vi.spyOn(cache, "getCache").mockImplementationOnce(async (...args) => {
        const inspected = await getCache(...args);
        await seedCache(replacement.value, replacement.updatedAt);
        return inspected;
      });
      if (mode === "read") await expect(loadPegAnalyticsCache(db)).resolves.toEqual({ kind: "miss", reason: "future-timestamp" });
      else await expect(publishPegAnalyticsCache(db, snapshot([]))).resolves.toBe(false);
      expect(await getCache(db, "peg-analytics")).toEqual(replacement);
    },
  );

  it("round-trips optional openIncidents sidecar, preserves legacy rows, and drops malformed sidecars cleanly", async () => {
    const openIncidents = { "usdt-tether": { eventId: 42, startedAt: NOW_SEC - DAY_SECONDS, escalatedAt: null } };
    expect(await publishPegAnalyticsCache(db, { ...snapshot([]), openIncidents })).toBe(true);
    expect(await loadPegAnalyticsCache(db, { maxAgeMs: Number.MAX_SAFE_INTEGER })).toMatchObject({ kind: "ok", payload: { openIncidents } });

    await seedCache(validPayload(NOW_SEC + 60), NOW_SEC + 60);
    const legacy = await loadPegAnalyticsCache(db, { maxAgeMs: Number.MAX_SAFE_INTEGER });
    expect(legacy.kind === "ok" && legacy.payload.openIncidents).toBeUndefined();

    await seedCache(validPayload(NOW_SEC + 120, { openIncidents: { "usdt-tether": { eventId: -1, startedAt: "bad", escalatedAt: null } } }), NOW_SEC + 120);
    const malformed = await loadPegAnalyticsCache(db, { maxAgeMs: Number.MAX_SAFE_INTEGER });
    expect(malformed.kind).toBe("ok");
    if (malformed.kind === "ok") {
      expect(malformed.payload.pegData).toHaveLength(1);
      expect(malformed.payload.openIncidents).toBeUndefined();
    }
  });
});
