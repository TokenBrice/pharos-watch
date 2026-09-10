import { describe, expect, it } from "vitest";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { computeReserveCompositionOverview, loadFreshIndependentLiveReserveMap, loadReserveSnapshotMetadataMap, resolveReserveResult } from "../live-reserves/store";
import { evaluateLiveReserveAdmission } from "../live-reserves/store-snapshot-state";
import { makeReservesDb, mockReserveD1, reserveCompositionRow, reserveSyncRow } from "./live-reserves-store.test-support";
import { resolveRedemptionCapacity } from "../redemption-backstop/capacity";
import { liveSnapshot } from "./redemption-backstop-sources.test-support";

function fixture(id = "hbd-hive", metadata: Record<string, unknown> = { freshnessMode: "not-applicable" }, fingerprint?: string, status = "ok") {
  const source = TRACKED_META_BY_ID.get(id)?.liveReservesConfig?.adapter ?? "infinifi";
  const composition = reserveCompositionRow({ stablecoin_id: id, source, metadata: JSON.stringify(metadata), config_fingerprint: fingerprint,
    adapter_source_model: "dynamic-mix", adapter_evidence_class: "independent", attempt_id: "success", warnings: "[]" });
  const sync = reserveSyncRow({ stablecoin_id: id, adapter_key: source, last_status: status, last_attempted_at: 1_100, last_success_attempt_id: "success" });
  return mockReserveD1([
    { match: "reserve_composition", rows: [composition], first: composition },
    { match: "reserve_sync_state", rows: [sync], first: sync },
  ]);
}

describe("live reserve admission", () => {
  it("rejects invalid admission before redemption capacity without replacing its evidence policy", async () => {
    const now = 1_780_000_000;
    const snapshot = liveSnapshot("lusd-liquity", {
      freshnessMode: "not-applicable",
      redemption: { capacityUsd: 400_000 },
    }, { fetchedAt: now - 60, source: "liquity-v1", sourceModel: "single-bucket" });
    const capacity = (reasons: NonNullable<typeof snapshot.admission>["reasons"]) => resolveRedemptionCapacity(
      mockReserveD1(), "lusd-liquity", { kind: "reserve-sync-metadata" }, 1_000_000, now,
      { reserveSnapshotMetadata: { ...snapshot, admission: { eligible: false, reasons } } },
    );
    expect((await capacity(["non-independent"])).immediateCapacityUsd).toBe(400_000);
    expect((await capacity(["config-mismatch"])).immediateCapacityUsd).toBeNull();
    expect((await capacity(["invalid-freshness"])).immediateCapacityUsd).toBeNull();
  });

  it("counts HBD's retained clean snapshot despite its later failed attempt", async () => {
    const db = fixture("hbd-hive", { freshnessMode: "not-applicable" }, undefined, "error");
    expect((await resolveReserveResult(db, "hbd-hive", 1_200))?.provenance?.scoringEligible).toBe(true);
    expect((await loadFreshIndependentLiveReserveMap(db, 1_200)).has("hbd-hive")).toBe(true);
    const overview = await computeReserveCompositionOverview(db, 1_200);
    expect(overview.independentFreshEligible).toBe(1);
    expect(overview.errorCoins).toBe(1);
  });

  it("does not recover malformed snapshot metadata from clean legacy attempt metadata", async () => {
    const db = makeReservesDb({
      composition: { metadata: "{broken" },
      syncState: { metadata: JSON.stringify({ freshnessMode: "not-applicable" }) },
    });
    expect((await resolveReserveResult(db, "iusd-infinifi", 1_200))?.provenance?.scoringEligible).toBe(false);
  });

  it("rejects an explicitly suspended current configuration", async () => {
    const coin = TRACKED_META_BY_ID.get("hbd-hive")!;
    const original = coin.liveReservesConfig!;
    try {
      coin.liveReservesConfig = { ...original, suspended: { reason: "Feed under review", since: "2026-09-09" } };
      const db = fixture();
      expect((await resolveReserveResult(db, coin.id, 1_200))?.provenance?.scoringEligible).toBe(false);
      expect((await loadFreshIndependentLiveReserveMap(db, 1_200)).has(coin.id)).toBe(false);
    } finally {
      coin.liveReservesConfig = original;
    }
  });

  it.each([
    {}, { sourceTimestamp: 1_000 }, { freshnessMode: "invalid", sourceTimestamp: 1_000 },
    { freshnessMode: "verified" }, { freshnessMode: "verified", sourceTimestamp: "1000" },
    { freshnessMode: "verified", sourceTimestamp: 1_801 },
    { freshnessMode: "not-applicable", sourceTimestamp: "invalid" },
  ])("rejects absent or malformed freshness consistently: %j", async (metadata) => {
    const db = fixture("hbd-hive", metadata);
    expect((await resolveReserveResult(db, "hbd-hive", 1_200))?.provenance?.scoringEligible).toBe(false);
    expect((await loadFreshIndependentLiveReserveMap(db, 1_200)).has("hbd-hive")).toBe(false);
    expect((await computeReserveCompositionOverview(db, 1_200)).independentFreshEligible).toBe(0);
  });

  it("accepts explicit verified timestamps through the future-skew boundary", async () => {
    const db = fixture("hbd-hive", { freshnessMode: "verified", sourceTimestamp: 1_800 });
    expect((await resolveReserveResult(db, "hbd-hive", 1_200))?.provenance?.scoringEligible).toBe(true);
  });

  it("rejects a changed config before detail, scoring, or redemption metadata use", async () => {
    const db = fixture("hbd-hive", { freshnessMode: "not-applicable" }, "old-config");
    expect((await resolveReserveResult(db, "hbd-hive", 1_200))?.mode).not.toBe("live");
    expect((await loadFreshIndependentLiveReserveMap(db, 1_200)).has("hbd-hive")).toBe(false);
    expect((await loadReserveSnapshotMetadataMap(db, ["hbd-hive"], 1_200)).has("hbd-hive")).toBe(false);
  });

  it("names config-mismatch as the rejection reason for a stale fingerprint", () => {
    const coin = TRACKED_META_BY_ID.get("hbd-hive")!;
    const record = {
      stablecoinId: "hbd-hive", slices: [{ name: "HBD", pct: 100, risk: "low" as const }], fetchedAt: 1_000, source: coin.liveReservesConfig!.adapter,
      metadata: { freshnessMode: "not-applicable" as const }, warnings: [], warningCount: 0,
      adapterSourceModel: "dynamic-mix" as const, adapterEvidenceClass: "independent" as const,
      configFingerprint: computeLiveReserveConfigFingerprint({ ...coin.liveReservesConfig!, version: coin.liveReservesConfig!.version + 1 }),
    };
    expect(evaluateLiveReserveAdmission(record, null, coin, 1_200).reasons).toContain("config-mismatch");
    expect(evaluateLiveReserveAdmission({ ...record, configFingerprint: computeLiveReserveConfigFingerprint(coin.liveReservesConfig!) }, null, coin, 1_200).reasons).not.toContain("config-mismatch");
  });

  it("accepts matching and legacy fingerprints but excludes internal diagnostics from detail", async () => {
    const config = TRACKED_META_BY_ID.get("hbd-hive")!.liveReservesConfig!;
    const db = fixture("hbd-hive", { freshnessMode: "not-applicable", diag: { durationMs: 123 }, supplyUsd: 456 }, computeLiveReserveConfigFingerprint(config));
    const detail = await resolveReserveResult(db, "hbd-hive", 1_200);
    expect(detail?.provenance?.scoringEligible).toBe(true);
    expect(detail?.metadata).toEqual({ freshnessMode: "not-applicable", supplyUsd: 456 });
  });

  it.each(["usdy-ondo-finance", "usdt-tether"])("never marks suspended or unconfigured %s eligible", async (id) => {
    const meta = TRACKED_META_BY_ID.get(id)!;
    const original = meta.liveReservesConfig;
    try {
      if (id === "usdt-tether") delete meta.liveReservesConfig;
      expect((await resolveReserveResult(fixture(id), id, 1_200))?.provenance?.scoringEligible).toBe(false);
    } finally {
      meta.liveReservesConfig = original;
    }
  });

  it("canonicalizes object keys while binding every semantic config input", () => {
    const config = TRACKED_META_BY_ID.get("hbd-hive")!.liveReservesConfig!;
    const first = { ...config, params: { z: 2, a: 1 } };
    const second = { ...config, params: { a: 1, z: 2 } };
    expect(computeLiveReserveConfigFingerprint(first)).toBe(computeLiveReserveConfigFingerprint(second));
    expect(computeLiveReserveConfigFingerprint({ ...first, version: first.version + 1 })).not.toBe(computeLiveReserveConfigFingerprint(first));
    expect(computeLiveReserveConfigFingerprint({ ...first, display: { url: "https://example.com" } })).toBe(computeLiveReserveConfigFingerprint(first));
  });
});
