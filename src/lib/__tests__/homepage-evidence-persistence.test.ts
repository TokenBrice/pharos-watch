import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HOMEPAGE_EVIDENCE_MAX_CHARS, HOMEPAGE_EVIDENCE_METHODOLOGY, HOMEPAGE_EVIDENCE_VERSION,
  mergeHomepageEvidence, parseHomepageEvidence, persistHomepageEvidence, restoreHomepageEvidence,
} from "@/lib/homepage-evidence-persistence";
import { reconcileHomepageEvidence, describeRetainedHomepageLane } from "@/lib/homepage-evidence";
import { HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS } from "@/lib/homepage-hero-snapshot";
import { HOMEPAGE_EVIDENCE_TEST_NOW as now, makeHomepageEvidence } from "@/test/fixtures/homepage-evidence";
import { deriveDataHealth } from "@/lib/data-health";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";

const encode = (snapshot = makeHomepageEvidence()) => JSON.stringify({
  version: HOMEPAGE_EVIDENCE_VERSION, methodology: HOMEPAGE_EVIDENCE_METHODOLOGY, snapshot,
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("compact homepage evidence admission", () => {
  it("restores original per-lane clocks and budgets, never receipt time", () => {
    const saved = makeHomepageEvidence(now / 1000 - 60);
    const restored = parseHomepageEvidence(encode(saved), now);
    expect(restored).toEqual(saved);
    const selected = reconcileHomepageEvidence(undefined, restored, now);
    expect(selected.retainedLanes).toEqual(["market", "psi", "incidents"]);
    expect(selected.data?.market.meta).toMatchObject({ updatedAt: saved.market.meta.updatedAt,
      freshBudgetSec: saved.market.meta.freshBudgetSec, status: "stale", reason: "retained-browser-evidence" });
    const health = deriveDataHealth({ ...DATA_HEALTH_PRESETS.stablecoins, hasData: true,
      dataUpdatedAt: now, meta: selected.data?.market.meta }, now);
    expect(health.state).toBe("stale");
    const label = describeRetainedHomepageLane(selected.data!.market.meta);
    expect(label).toContain("Retained");
    expect(label).toContain(new Date((now / 1000 - 60) * 1000).toISOString());
    expect(label).toContain(`stale after ${saved.market.meta.freshBudgetSec / 60} min`);
  });

  it("expires at the producer-age limit, inclusively, and rejects future/unknown clocks", () => {
    const boundary = makeHomepageEvidence((now - HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS) / 1000);
    expect(parseHomepageEvidence(encode(boundary), now)).not.toBeNull();
    expect(parseHomepageEvidence(encode(boundary), now + 1)).toBeNull();
    expect(parseHomepageEvidence(encode(makeHomepageEvidence(now / 1000 + 1)), now)).toBeNull();
    const unknown = makeHomepageEvidence();
    for (const lane of Object.values(unknown)) {
      lane.meta = { ...lane.meta, updatedAt: null, ageSeconds: null, status: "unknown", reason: "missing-generation" };
    }
    expect(parseHomepageEvidence(encode(unknown), now)).toBeNull();
    expect(reconcileHomepageEvidence(undefined, boundary, now + 1).data?.market.data).toBeNull();
  });

  it.each([
    "{", "null", JSON.stringify({ version: 0 }),
    encode().replace(HOMEPAGE_EVIDENCE_METHODOLOGY, "old-methodology"),
    encode().replace(`"version":${HOMEPAGE_EVIDENCE_VERSION}`, `"version":${HOMEPAGE_EVIDENCE_VERSION + 1}`),
    encode().replace('"totalUsd":100', '"totalUsd":"broken"'),
    "x".repeat(HOMEPAGE_EVIDENCE_MAX_CHARS + 1),
  ])("tolerates corruption, schema/format and methodology changes", (raw) => {
    expect(parseHomepageEvidence(raw, now)).toBeNull();
  });

  it("expires independent lanes without withholding a younger sibling", () => {
    const saved = makeHomepageEvidence((now - HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS - 1) / 1000);
    saved.psi = makeHomepageEvidence().psi;
    const restored = parseHomepageEvidence(encode(saved), now);
    expect(restored).not.toBeNull();
    const selected = reconcileHomepageEvidence(undefined, restored, now);
    expect(selected.retainedLanes).toEqual(["psi"]);
    expect(selected.data?.market.data).toBeNull();
    expect(selected.data?.incidents.data).toBeNull();
    expect(selected.data?.psi.data).toEqual(saved.psi.data);
    const corruptDate = makeHomepageEvidence();
    corruptDate.market.data!.asOfISO = "invalid-date";
    expect(parseHomepageEvidence(encode(corruptDate), now)).toBeNull();
  });

  it("reconciles independently by generation, not envelope receipt, and qualifies equal/newer live evidence", () => {
    const saved = makeHomepageEvidence(now / 1000 - 60);
    const live = makeHomepageEvidence(now / 1000 - 120);
    live.psi = makeHomepageEvidence().psi;
    const selection = reconcileHomepageEvidence(live, saved, now);
    expect(selection.retainedLanes).toEqual(["market", "incidents"]);
    expect(selection.data?.market.data).toEqual(saved.market.data);
    expect(selection.data?.psi).toEqual(live.psi);
    expect(reconcileHomepageEvidence(saved, saved, now).retainedLanes).toEqual([]);
    expect(reconcileHomepageEvidence(makeHomepageEvidence(), saved, now).retainedLanes).toEqual([]);
    const merged = mergeHomepageEvidence(saved, live, now);
    expect(merged.market).toEqual(saved.market);
    expect(merged.psi).toEqual(live.psi);
  });

  it("keeps a failed live lane retained, never fresh or measured zero", () => {
    const saved = makeHomepageEvidence(now / 1000 - 60);
    const failed = makeHomepageEvidence();
    failed.incidents = { data: null, meta: { ...failed.incidents.meta, updatedAt: null,
      ageSeconds: null, status: "unknown", reason: "source-read-failed" } };
    const result = reconcileHomepageEvidence(failed, saved, now);
    expect(result.data?.incidents.data?.activeDepegCount).toBe(1);
    expect(result.data?.incidents.meta.status).toBe("stale");
    expect(result.retainedLanes).toEqual(["incidents"]);
    expect(reconcileHomepageEvidence(failed, null, now).data?.incidents.data).toBeNull();
  });
});

/** Minimal asynchronous IDB harness: exercises the production request/transaction callbacks. */
function installIndexedDb(initial?: string) {
  let stored = initial;
  const close = vi.fn();
  const put = vi.fn((value: string) => { stored = value; });
  const database = {
    close,
    objectStoreNames: { contains: () => true },
    transaction: vi.fn(() => {
      const transaction = { oncomplete: null as (() => void) | null, onabort: null, onerror: null,
        objectStore: () => ({ put, get: () => {
          const request = { result: stored, onsuccess: null as (() => void) | null };
          queueMicrotask(() => {
            request.onsuccess?.();
            queueMicrotask(() => transaction.oncomplete?.());
          });
          return request;
        } }),
      };
      return transaction;
    }),
  };
  const open = vi.fn(() => {
    const request = { result: database, onsuccess: null as (() => void) | null, onerror: null, onblocked: null };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  });
  vi.stubGlobal("indexedDB", { open });
  return { open, database, put, close, stored: () => stored };
}

describe("asynchronous IndexedDB envelope", () => {
  it("roundtrips only the compact validated projection and reconciles newer stored generations", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const disk = installIndexedDb();
    const data = makeHomepageEvidence();
    await persistHomepageEvidence({ ...data, privateField: "not-persisted", cards: ["not-persisted"] });
    expect(disk.put).toHaveBeenCalledOnce();
    expect(disk.stored()).not.toContain("not-persisted");
    expect(disk.stored()!.length).toBeLessThan(HOMEPAGE_EVIDENCE_MAX_CHARS);
    await expect(restoreHomepageEvidence()).resolves.toEqual(data);
    await persistHomepageEvidence(makeHomepageEvidence(now / 1000 - 60));
    await expect(restoreHomepageEvidence()).resolves.toEqual(data);
    expect(disk.database.transaction).toHaveBeenCalledWith("snapshots", "readwrite");
    expect(disk.database.transaction).toHaveBeenCalledWith("snapshots", "readonly");
    expect(disk.close).toHaveBeenCalled();
  });

  it("does not write invalid publications and tolerates unavailable or corrupt storage", async () => {
    const disk = installIndexedDb("{");
    await persistHomepageEvidence({ cards: Array(1000).fill({}) });
    expect(disk.open).not.toHaveBeenCalled();
    await expect(restoreHomepageEvidence()).resolves.toBeNull();
    vi.stubGlobal("indexedDB", { open: () => { throw new Error("Storage denied"); } });
    await expect(restoreHomepageEvidence()).resolves.toBeNull();
    await expect(persistHomepageEvidence(makeHomepageEvidence())).resolves.toBeUndefined();
    vi.stubGlobal("indexedDB", undefined);
    await expect(restoreHomepageEvidence()).resolves.toBeNull();
  });
});
