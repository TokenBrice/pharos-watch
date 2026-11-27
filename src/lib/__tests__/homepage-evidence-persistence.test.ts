import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HOMEPAGE_EVIDENCE_MAX_CHARS, HOMEPAGE_EVIDENCE_METHODOLOGY, HOMEPAGE_EVIDENCE_VERSION,
  mergeHomepageEvidence, parseHomepageEvidence, persistHomepageEvidence, restoreHomepageEvidence,
} from "@/lib/homepage-evidence-persistence";
import { reconcileHomepageEvidence } from "@/lib/homepage-evidence";
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
    const saved = makeHomepageEvidence(now / 1000 - 60), restored = parseHomepageEvidence(encode(saved), now);
    expect(restored).toEqual(saved);
    const selected = reconcileHomepageEvidence(undefined, restored, now);
    expect(selected.retainedLanes).toEqual(["market", "psi", "incidents"]);
    expect(selected.data?.market.meta).toMatchObject({ updatedAt: saved.market.meta.updatedAt, freshBudgetSec: saved.market.meta.freshBudgetSec, status: "stale", reason: "retained-browser-evidence" });
    expect(deriveDataHealth({ ...DATA_HEALTH_PRESETS.stablecoins, hasData: true, dataUpdatedAt: now, meta: selected.data?.market.meta }, now).state).toBe("stale");
  });
  it("expires at the producer-age limit, inclusively, and rejects future/unknown clocks", () => {
    const boundary = makeHomepageEvidence((now - HOMEPAGE_HERO_MAX_FALLBACK_AGE_MS) / 1000);
    expect(parseHomepageEvidence(encode(boundary), now)).not.toBeNull();
    expect(parseHomepageEvidence(encode(boundary), now + 1)).toBeNull();
    expect(parseHomepageEvidence(encode(makeHomepageEvidence(now / 1000 + 1)), now)).toBeNull();
    const unknown = makeHomepageEvidence();
    for (const lane of Object.values(unknown)) lane.meta = { ...lane.meta, updatedAt: null, ageSeconds: null, status: "unknown", reason: "missing-generation" };
    expect(parseHomepageEvidence(encode(unknown), now)).toBeNull();
    expect(reconcileHomepageEvidence(undefined, boundary, now + 1).data?.market.data).toBeNull();
  });
  it.each([
    "{", "null", JSON.stringify({ version: 0 }), encode().replace(HOMEPAGE_EVIDENCE_METHODOLOGY, "old-methodology"),
    encode().replace(`"version":${HOMEPAGE_EVIDENCE_VERSION}`, `"version":${HOMEPAGE_EVIDENCE_VERSION + 1}`),
    encode().replace(`"version":${HOMEPAGE_EVIDENCE_VERSION}`, `"version":1`),
    encode().replace('"totalUsd":100', '"totalUsd":"broken"'), "x".repeat(HOMEPAGE_EVIDENCE_MAX_CHARS + 1),
  ])("tolerates corruption, schema/format and methodology changes", (raw) => { expect(parseHomepageEvidence(raw, now)).toBeNull(); });
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
    const corruptDate = makeHomepageEvidence(); corruptDate.market.data!.asOfISO = "invalid-date";
    expect(parseHomepageEvidence(encode(corruptDate), now)).toBeNull();
  });
  it("reconciles independently by generation, not envelope receipt, and qualifies equal/newer live evidence", () => {
    const saved = makeHomepageEvidence(now / 1000 - 60), live = makeHomepageEvidence(now / 1000 - 120);
    live.psi = makeHomepageEvidence().psi;
    const selection = reconcileHomepageEvidence(live, saved, now);
    expect(selection.retainedLanes).toEqual(["market", "incidents"]);
    expect(selection.data?.market.data).toEqual(saved.market.data);
    expect(selection.data?.psi).toEqual(live.psi);
    expect(reconcileHomepageEvidence(saved, saved, now).retainedLanes).toEqual([]);
    expect(reconcileHomepageEvidence(makeHomepageEvidence(), saved, now).retainedLanes).toEqual([]);
    const merged = mergeHomepageEvidence(saved, live, now);
    expect(merged.market).toEqual(saved.market); expect(merged.psi).toEqual(live.psi);
  });
  it("keeps a failed live lane retained, never fresh or measured zero", () => {
    const saved = makeHomepageEvidence(now / 1000 - 60), failed = makeHomepageEvidence();
    failed.incidents = { data: null, meta: { ...failed.incidents.meta, updatedAt: null, ageSeconds: null, status: "unknown", reason: "source-read-failed" } };
    const result = reconcileHomepageEvidence(failed, saved, now);
    expect(result.data?.incidents.data?.activeDepegCount).toBe(1);
    expect(result.data?.incidents.meta.status).toBe("stale");
    expect(result.retainedLanes).toEqual(["incidents"]);
    expect(reconcileHomepageEvidence(failed, null, now).data?.incidents.data).toBeNull();
  });
  it("rotates on peg:6.56 and admits split/unsplit incidents", () => {
    expect([HOMEPAGE_EVIDENCE_VERSION, HOMEPAGE_EVIDENCE_METHODOLOGY.includes("peg:6.56")]).toEqual([2, true]);
    expect(parseHomepageEvidence(encode().replace("peg:6.56", "peg:6.55"), now)).toBeNull();
    for (const d of [{ activeDepegCount: 17, recentActiveDepegCount: 4, longRunningActiveDepegCount: 13 }, { activeDepegCount: 17 }]) {
      const s = makeHomepageEvidence(now / 1000 - 30); s.incidents.data = d;
      expect(parseHomepageEvidence(encode(s), now)?.incidents.data).toEqual(d);
    }
  });
});

function installIndexedDb(initial?: string) {
  let stored = initial;
  const close = vi.fn(), put = vi.fn((value: string) => { stored = value; });
  const database = {
    close, objectStoreNames: { contains: () => true },
    transaction: vi.fn(() => {
      const tx = { oncomplete: null as (() => void) | null, onabort: null, onerror: null, objectStore: () => ({ put, get: () => {
        const req = { result: stored, onsuccess: null as (() => void) | null };
        queueMicrotask(() => { req.onsuccess?.(); queueMicrotask(() => tx.oncomplete?.()); }); return req;
      } }) };
      return tx;
    }),
  };
  const open = vi.fn(() => { const req = { result: database, onsuccess: null as (() => void) | null, onerror: null, onblocked: null }; queueMicrotask(() => req.onsuccess?.()); return req; });
  vi.stubGlobal("indexedDB", { open });
  return { open, database, put, close, stored: () => stored };
}

describe("asynchronous IndexedDB envelope", () => {
  it("roundtrips only the compact validated projection and reconciles newer stored generations", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const disk = installIndexedDb(), data = makeHomepageEvidence();
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
