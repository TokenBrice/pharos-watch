import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DETAIL_EVIDENCE_MAX_CHARS, DETAIL_EVIDENCE_MAX_COINS, DETAIL_EVIDENCE_VERSION,
  parseDetailEvidence, persistDetailEvidence, restoreDetailEvidence,
} from "@/lib/detail-evidence-persistence";
import { selectDetailEvidence } from "@/lib/detail-evidence-selection";
import { HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS } from "@/lib/homepage-hero-snapshot";
import { DETAIL_EVIDENCE_TEST_NOW as now, makeDetailEvidence } from "@/test/fixtures/detail-evidence";

const encode = (evidence = makeDetailEvidence()) => JSON.stringify({ version: DETAIL_EVIDENCE_VERSION,
  entries: [{ coinId: "usdt-tether", evidence }] });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function installIndexedDb(initial?: string) {
  let stored = initial;
  const close = vi.fn();
  const put = vi.fn((value: string) => { stored = value; });
  const database = { close, transaction: vi.fn(() => {
    const transaction = { oncomplete: null as (() => void) | null, onabort: null, onerror: null,
      objectStore: () => ({ put, get: () => {
        const request = { result: stored, onsuccess: null as (() => void) | null };
        queueMicrotask(() => { request.onsuccess?.(); queueMicrotask(() => transaction.oncomplete?.()); });
        return request;
      } }),
    };
    return transaction;
  }) };
  const open = vi.fn(() => {
    const request = { result: database, onsuccess: null as (() => void) | null };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  });
  vi.stubGlobal("indexedDB", { open });
  return { open, database, put, stored: () => stored };
}

describe("detail evidence admission and generation reconciliation", () => {
  it("restores original clocks/budgets with retained status, never receipt-time freshness", () => {
    const saved = makeDetailEvidence();
    saved.data.priceObservedAt = now / 1000 - 20;
    saved.data.supplyObservedAt = now / 1000 - 30;
    const restored = parseDetailEvidence(encode(saved), now)[0].evidence;
    expect(restored).toEqual(saved);
    const selected = selectDetailEvidence({ data: undefined, meta: null }, restored, now);
    expect(selected).toMatchObject({ data: saved.data, isRetained: true, meta: {
      updatedAt: saved.meta.updatedAt, freshBudgetSec: 600, degradedBudgetSec: 7200,
      status: "stale", reason: "retained-browser-evidence",
    } });
    expect(selected.data?.priceObservedAt).toBe(saved.data.priceObservedAt);
    expect(selected.data?.supplyObservedAt).toBe(saved.data.supplyObservedAt);
  });

  it("expires by producer age at the existing inclusive ceiling and rejects future/unknown clocks", () => {
    const saved = makeDetailEvidence((now - HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS) / 1000);
    expect(parseDetailEvidence(encode(saved), now)).toHaveLength(1);
    expect(parseDetailEvidence(encode(saved), now + 1)).toEqual([]);
    expect(selectDetailEvidence({ data: undefined, meta: null }, saved, now + 1).data).toBeUndefined();
    expect(parseDetailEvidence(encode(makeDetailEvidence(now / 1000 + 1)), now)).toEqual([]);
    const invalidOverlay = makeDetailEvidence();
    invalidOverlay.data.priceObservedAt = now / 1000 + 1;
    expect(parseDetailEvidence(encode(invalidOverlay), now)).toEqual([]);
    invalidOverlay.data.priceObservedAt = (now - HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS - 1) / 1000;
    expect(parseDetailEvidence(encode(invalidOverlay), now)).toEqual([]);
    const missing = { ...saved, meta: { updatedAt: null, ageSeconds: null, status: "unknown", reason: "missing" } };
    expect(parseDetailEvidence(JSON.stringify({ version: 1, entries: [{ coinId: "usdt-tether", evidence: missing }] }), now)).toEqual([]);
  });

  it.each(["{", "null", encode().replace('"version":1', '"version":2'),
    encode().replace('"price":1', '"price":"bad"'), "x".repeat(DETAIL_EVIDENCE_MAX_CHARS + 1),
    encode().replace("usdt-tether", "usdt-tether?wallet=private"),
  ])("tolerates corruption, incompatible versions and invalid privacy keys", (raw) => {
    expect(parseDetailEvidence(raw, now)).toEqual([]);
  });

  it("selects newest build/retained/live generations and admits equal-clock current quarantine", () => {
    const saved = makeDetailEvidence(now / 1000 - 60, 1.02);
    const build = makeDetailEvidence(now / 1000 - 120, 0.99);
    expect(selectDetailEvidence(build, saved, now, true).data?.price).toBe(1.02);
    expect(selectDetailEvidence(makeDetailEvidence(now / 1000, 1.03), saved, now).data?.price).toBe(1.03);
    expect(selectDetailEvidence(saved, build, now, true).isRetained).toBe(false);
    const sameHistory = makeDetailEvidence(saved.meta.updatedAt!);
    sameHistory.data.priceUpdatedAt = now / 1000 - 120;
    sameHistory.data.supplyObservedAt = now / 1000 - 120;
    expect(selectDetailEvidence(sameHistory, saved, now, true).isRetained).toBe(true);
    const quarantine = makeDetailEvidence(saved.meta.updatedAt!);
    quarantine.data.circulating = {};
    quarantine.data.nativeSupply.current = null;
    quarantine.data.supplyObservedAt = null;
    quarantine.data.supplyRestored = true;
    expect(selectDetailEvidence(quarantine, saved, now)).toMatchObject({ isRetained: false,
      data: { circulating: {}, nativeSupply: { current: null } } });
  });
});

describe("bounded detail IndexedDB evidence", () => {
  it("roundtrips only the compact validated projection and prevents older writes rolling back disk", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const disk = installIndexedDb();
    await persistDetailEvidence("usdt-tether", { ...makeDetailEvidence(), privateField: "never-persist",
      data: { ...makeDetailEvidence().data, wallet: "never-persist", tokens: ["never-persist"] } });
    expect(disk.stored()).not.toContain("never-persist");
    await expect(restoreDetailEvidence("usdt-tether")).resolves.toEqual(makeDetailEvidence());
    await persistDetailEvidence("usdt-tether", makeDetailEvidence(now / 1000 - 120));
    await expect(restoreDetailEvidence("usdt-tether")).resolves.toEqual(makeDetailEvidence());
    expect(disk.database.transaction).toHaveBeenCalledWith("snapshots", "readwrite");
    expect(disk.stored()!.length).toBeLessThanOrEqual(DETAIL_EVIDENCE_MAX_CHARS);
  });

  it("evicts least recently used coins, touches restored coins and physically prunes expired entries", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const disk = installIndexedDb();
    for (let index = 0; index < DETAIL_EVIDENCE_MAX_COINS; index++) await persistDetailEvidence(`coin-${index}`, makeDetailEvidence());
    await restoreDetailEvidence("coin-0");
    await persistDetailEvidence("coin-20", makeDetailEvidence());
    expect(parseDetailEvidence(disk.stored(), now).map((entry) => entry.coinId)).not.toContain("coin-1");
    expect(parseDetailEvidence(disk.stored(), now).map((entry) => entry.coinId)).toContain("coin-0");
    expect(parseDetailEvidence(disk.stored(), now)).toHaveLength(DETAIL_EVIDENCE_MAX_COINS);
    clock.mockReturnValue(now + HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS);
    await expect(restoreDetailEvidence("coin-0")).resolves.toBeNull();
    expect(JSON.parse(disk.stored()!).entries).toEqual([]);
  });

  it("ignores invalid publications and tolerates corrupt, missing or denied storage", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const disk = installIndexedDb("{");
    await persistDetailEvidence("coin", { cards: [] });
    expect(disk.open).not.toHaveBeenCalled();
    await expect(restoreDetailEvidence("coin")).resolves.toBeNull();
    vi.stubGlobal("indexedDB", { open: () => { throw new Error("denied"); } });
    await expect(restoreDetailEvidence("coin")).resolves.toBeNull();
    await expect(persistDetailEvidence("coin", makeDetailEvidence())).resolves.toBeUndefined();
    vi.stubGlobal("indexedDB", undefined);
    await expect(restoreDetailEvidence("coin")).resolves.toBeNull();
  });
});
