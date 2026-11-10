import { describe, expect, it } from "vitest";
import { computeLiveReserveConfigFingerprint, getLiveReserveAdapterDefinition, LiveReservesConfigSchema } from "@shared/lib/live-reserve-adapters";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { computeReserveCompositionOverview, loadFreshIndependentLiveReserveMap, loadReserveSnapshotMetadataMap } from "../live-reserves/store";
import { resolveReserveResult } from "../live-reserves/store-views";
import { evaluateLiveReserveAdmission } from "../live-reserves/store-snapshot-state";
import { parseReserveCompositionRow, parseSnapshotMetadata } from "../live-reserves/store-row-decoding";
import {
  decodeLiveReserveRedemptionTelemetry,
  LIVE_RESERVE_EVIDENCE_CLASS_VALUES,
  LIVE_RESERVE_FRESHNESS_MODE_VALUES,
  LIVE_RESERVE_REDEMPTION_CAPACITY_KIND_VALUES,
  LIVE_RESERVE_REDEMPTION_FRESHNESS_KIND_VALUES,
  LIVE_RESERVE_REDEMPTION_ROUTE_STATUS_SOURCE_VALUES,
  LIVE_RESERVE_REDEMPTION_ROUTE_STATUS_VALUES,
  LIVE_RESERVE_SOURCE_MODEL_VALUES,
  LIVE_RESERVE_WARNING_EFFECT_VALUES,
} from "@shared/types/live-reserves";
import { makeReservesDb, mockReserveD1, reserveCompositionRow, reserveSyncRow } from "./live-reserves-store.test-support";
import { resolveRedemptionCapacity } from "../redemption-backstop/capacity";
import { liveSnapshot } from "./redemption-backstop-sources.test-support";
import { getReserves } from "@shared/lib/reserve-templates";
import { resolveScheduledSlotPolicy } from "../scheduled-slot-policy";

function fixture(id = "hbd-hive", metadata: Record<string, unknown> = { freshnessMode: "not-applicable" }, fingerprint?: string, status = "ok") {
  const source = TRACKED_META_BY_ID.get(id)?.liveReservesConfig?.adapter ?? "infinifi";
  const config = TRACKED_META_BY_ID.get(id)?.liveReservesConfig;
  const composition = reserveCompositionRow({ stablecoin_id: id, source, metadata: JSON.stringify(metadata), config_fingerprint: fingerprint ?? (config ? computeLiveReserveConfigFingerprint(config) : null),
    adapter_source_model: "dynamic-mix", adapter_evidence_class: "independent", attempt_id: "success", warnings: "[]" });
  const sync = reserveSyncRow({ stablecoin_id: id, adapter_key: source, last_status: status, last_attempted_at: 1_100, last_success_attempt_id: "success" });
  return mockReserveD1([
    { match: "reserve_composition", rows: [composition], first: composition },
    { match: "reserve_sync_state", rows: [sync], first: sync },
  ]);
}

describe("live reserve admission", () => {
  it.each([
    "qcad-stablecorp", "usx-solstice", "satusd-river", "usdv-solomon-v2",
    "dgld-gold-token-sa", "xagm-matrixdock", "onyc-onre", "avusd-avant",
    "ftusd-flying-tulip", "frnt-wyoming", "usdy-ondo-finance",
  ])("keeps a healthy current %s observation non-independent", (id) => {
    const coin = TRACKED_META_BY_ID.get(id)!;
    const config = coin.liveReservesConfig!;
    const record = {
      stablecoinId: id, source: config.adapter,
      slices: [{ name: "Issuer observation", pct: 100, risk: "low" as const }],
      fetchedAt: 1_780_000_000,
      metadata: { freshnessMode: "verified" as const, sourceTimestamp: 1_780_000_000 },
      warnings: [], warningCount: 0, adapterSourceModel: "single-bucket" as const,
      adapterEvidenceClass: "weak-live-probe" as const,
      configFingerprint: computeLiveReserveConfigFingerprint(config),
    };
    const admission = evaluateLiveReserveAdmission(record, null, coin, 1_780_000_001);
    expect(admission.eligible).toBe(false);
    expect(admission.reasons).toContain("non-independent");
  });

  it("rejects retained Sonic observations for the unconfigured legacy bnUSD identity", () => {
    const coin = WORKER_TRACKED_META_BY_ID.get("bnusd-balanced")!;
    expect(coin.liveReservesConfig).toBeUndefined();
    expect(TRACKED_META_BY_ID.get(coin.id)?.liveReservesConfig).toBeUndefined();
    const record = {
      stablecoinId: coin.id, source: "sodax-sonic",
      slices: [{ name: "Sonic borrower observation", pct: 100, risk: "low" as const }],
      fetchedAt: 1_780_000_000,
      metadata: { freshnessMode: "verified" as const, sourceTimestamp: 1_780_000_000 },
      warnings: [], warningCount: 0, adapterSourceModel: "dynamic-mix" as const,
      adapterEvidenceClass: "weak-live-probe" as const,
      configFingerprint: null,
    };
    const sync = { lastSuccessAt: record.fetchedAt, lastSuccessAttemptId: null };
    const admission = evaluateLiveReserveAdmission(record, sync, coin, 1_780_000_001);
    expect(admission.eligible).toBe(false);
    expect(admission.reasons).toEqual(["unconfigured", "non-independent"]);
    const publicAdmission = evaluateLiveReserveAdmission(record, sync, TRACKED_META_BY_ID.get(coin.id), 1_780_000_001);
    expect(publicAdmission.eligible).toBe(false);
    expect(publicAdmission.reasons).toEqual(["unconfigured", "non-independent"]);
  });

  it("rejects invalid admission before redemption capacity without replacing its evidence policy", async () => {
    const now = 1_780_000_000;
    const snapshot = liveSnapshot("lusd-liquity", {
      freshnessMode: "not-applicable",
      redemption: { capacityUsd: 400_000 },
    }, { fetchedAt: now - 60, source: "liquity-v1", sourceModel: "single-bucket" });
    const capacity = (reasons: NonNullable<typeof snapshot.admission>["reasons"]) => resolveRedemptionCapacity(
      mockReserveD1(), "lusd-liquity", { kind: "reserve-sync-metadata" }, 1_000_000, now,
      { reserveSnapshotMetadata: { ...snapshot, admission: { eligible: false, reasons, freshness: null } } },
    );
    expect((await capacity(["non-independent"])).immediateCapacityUsd).toBe(400_000);
    expect((await capacity(["config-mismatch"])).immediateCapacityUsd).toBeNull();
    expect((await capacity(["invalid-freshness"])).immediateCapacityUsd).toBeNull();
  });

  it("counts HBD's retained clean snapshot despite its later failed attempt", async () => {
    const db = fixture("hbd-hive", { freshnessMode: "not-applicable" }, undefined, "error");
    expect((await resolveReserveResult(db, "hbd-hive", 1_200))?.provenance?.scoringEligible).toBe(true);
    expect((await loadFreshIndependentLiveReserveMap(db, 1_200)).has("hbd-hive")).toBe(true);
    const overview = await computeReserveCompositionOverview(db, 1_200, resolveScheduledSlotPolicy("fourHourlyReserveSync"));
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
    const runtimeCoin = WORKER_TRACKED_META_BY_ID.get(coin.id)!;
    const originalRuntimeConfig = runtimeCoin.liveReservesConfig;
    const original = coin.liveReservesConfig!;
    try {
      coin.liveReservesConfig = { ...original, suspended: { reason: "Feed under review", since: "2026-09-09" } };
      runtimeCoin.liveReservesConfig = coin.liveReservesConfig;
      const db = fixture();
      expect((await resolveReserveResult(db, coin.id, 1_200))?.provenance?.scoringEligible).toBe(false);
      expect((await loadFreshIndependentLiveReserveMap(db, 1_200)).has(coin.id)).toBe(false);
    } finally {
      coin.liveReservesConfig = original;
      runtimeCoin.liveReservesConfig = originalRuntimeConfig;
    }
  });

  it.each([
    {}, { sourceTimestamp: 1_000 }, { freshnessMode: "invalid", sourceTimestamp: 1_000 },
    { freshnessMode: "verified" }, { freshnessMode: "verified", sourceTimestamp: "1000" },
    { freshnessMode: "verified", sourceTimestamp: 0 }, { freshnessMode: "verified", sourceTimestamp: -1 },
    { freshnessMode: "verified", sourceTimestamp: 1_801 },
    { freshnessMode: "not-applicable", sourceTimestamp: "invalid" },
  ])("rejects absent or malformed freshness consistently: %j", async (metadata) => {
    const db = fixture("hbd-hive", metadata);
    expect((await resolveReserveResult(db, "hbd-hive", 1_200))?.provenance?.scoringEligible).toBe(false);
    expect((await loadFreshIndependentLiveReserveMap(db, 1_200)).has("hbd-hive")).toBe(false);
    expect((await computeReserveCompositionOverview(db, 1_200, resolveScheduledSlotPolicy("fourHourlyReserveSync"))).independentFreshEligible).toBe(0);
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

  it.each([2, 3, 4])("rejects retained crvUSD v%s books without renewing their original evidence", async (version) => {
    const coin = TRACKED_META_BY_ID.get("crvusd-curve")!;
    const config = coin.liveReservesConfig!;
    expect(config.version).toBe(5);
    expect(WORKER_TRACKED_META_BY_ID.get(coin.id)?.liveReservesConfig?.version).toBe(5);
    expect(getLiveReserveAdapterDefinition(config.adapter)?.configValidation.allowedVersions).toEqual([5]);
    expect(LiveReservesConfigSchema.safeParse(config).success).toBe(true);
    expect(LiveReservesConfigSchema.safeParse({ ...config, version }).success).toBe(false);
    const metadata = { freshnessMode: "not-applicable" as const };
    const fingerprint = computeLiveReserveConfigFingerprint({ ...config, version });
    const record = {
      stablecoinId: coin.id, source: config.adapter, fetchedAt: 1_000,
      slices: [{ name: "Retained collateral", pct: 100, risk: "medium" as const }],
      metadata, warnings: [], warningCount: 0, adapterSourceModel: "dynamic-mix" as const,
      adapterEvidenceClass: "independent" as const, configFingerprint: fingerprint,
    };
    expect(evaluateLiveReserveAdmission(record, { lastSuccessAt: 1_000, lastSuccessAttemptId: null }, coin, 1_200).reasons)
      .toContain("config-mismatch");
    const db = fixture(coin.id, metadata, fingerprint);
    expect((await resolveReserveResult(db, coin.id, 1_200))?.mode).not.toBe("live");
    expect((await loadFreshIndependentLiveReserveMap(db, 1_200)).has(coin.id)).toBe(false);
    expect((await loadReserveSnapshotMetadataMap(db, [coin.id], 1_200)).has(coin.id)).toBe(false);
    const currentDb = fixture(coin.id, metadata, computeLiveReserveConfigFingerprint(config));
    expect((await resolveReserveResult(currentDb, coin.id, 1_200))?.provenance?.scoringEligible).toBe(true);
  });

  it.each([
    { id: "usdai-usd-ai", version: 2, legacyVersions: [1] },
    { id: "usdat-saturn", version: 2, legacyVersions: [1] },
    { id: "dai-makerdao", version: 3, legacyVersions: [1, 2] },
    { id: "usds-sky", version: 3, legacyVersions: [1, 2] },
    { id: "usdp-parallel", version: 2, legacyVersions: [1] },
    { id: "satusd-river", version: 2, legacyVersions: [1] },
  ])("rejects retained mixed-head $id packets without renewing their clocks", async ({ id, version, legacyVersions }) => {
    const coin = TRACKED_META_BY_ID.get(id)!;
    const config = coin.liveReservesConfig!;
    const adapter = getLiveReserveAdapterDefinition(config.adapter)!;
    expect(config.version).toBe(version);
    expect(adapter.configValidation.allowedVersions).toEqual([version]);
    expect(LiveReservesConfigSchema.safeParse(config).success).toBe(true);
    const record = {
      stablecoinId: id, source: config.adapter, fetchedAt: 1_100,
      slices: [{ name: "Retained reserve observation", pct: 100, risk: "low" as const }],
      metadata: { freshnessMode: "verified" as const, sourceTimestamp: 1_000 },
      warnings: [], warningCount: 0, adapterSourceModel: adapter.sourceModel,
      adapterEvidenceClass: adapter.evidenceClass,
      configFingerprint: computeLiveReserveConfigFingerprint(config),
    };
    const sync = { lastSuccessAt: 1_100, lastSuccessAttemptId: null };
    expect(evaluateLiveReserveAdmission(record, sync, coin, 1_200).reasons).not.toContain("config-mismatch");
    for (const legacyVersion of legacyVersions) {
      const legacyConfig = { ...config, version: legacyVersion };
      expect(LiveReservesConfigSchema.safeParse(legacyConfig).success).toBe(false);
      const fingerprint = computeLiveReserveConfigFingerprint(legacyConfig);
      expect(evaluateLiveReserveAdmission({ ...record, configFingerprint: fingerprint }, sync, coin, 1_200).reasons)
        .toContain("config-mismatch");
      const db = fixture(id, record.metadata, fingerprint);
      expect((await resolveReserveResult(db, id, 1_200))?.mode).not.toBe("live");
      expect((await loadReserveSnapshotMetadataMap(db, [id], 1_200)).has(id)).toBe(false);
    }
    expect(record.fetchedAt).toBe(1_100);
    expect(record.metadata.sourceTimestamp).toBe(1_000);
  });

  it.each([
    { id: "fpi-frax", version: 3, legacyVersions: [1, 2] },
    { id: "ftusd-flying-tulip", version: 2, legacyVersions: [1] },
    { id: "jupusd-jupiter", version: 2, legacyVersions: [1] },
    { id: "usdx-kava", version: 2, legacyVersions: [1] },
  ])("rejects retained incomplete-scope $id bindings before detail or metadata use", async ({ id, version, legacyVersions }) => {
    const coin = TRACKED_META_BY_ID.get(id)!;
    const config = coin.liveReservesConfig!;
    const adapter = getLiveReserveAdapterDefinition(config.adapter)!;
    expect(config.version).toBe(version);
    expect(WORKER_TRACKED_META_BY_ID.get(id)?.liveReservesConfig?.version).toBe(version);
    expect(adapter.configValidation.allowedVersions).toEqual([version]);
    expect(LiveReservesConfigSchema.safeParse(config).success).toBe(true);
    const metadata = { freshnessMode: "not-applicable" as const };
    const current = await resolveReserveResult(fixture(id, metadata), id, 1_200);
    expect(current?.mode).toBe("live");
    for (const legacyVersion of legacyVersions) {
      const oldConfig = { ...config, version: legacyVersion };
      expect(LiveReservesConfigSchema.safeParse(oldConfig).success).toBe(false);
      const fingerprint = computeLiveReserveConfigFingerprint(oldConfig);
      const db = fixture(id, metadata, fingerprint);
      expect((await resolveReserveResult(db, id, 1_200))?.mode).not.toBe("live");
      expect((await loadFreshIndependentLiveReserveMap(db, 1_200)).has(id)).toBe(false);
      expect((await loadReserveSnapshotMetadataMap(db, [id], 1_200)).has(id)).toBe(false);
    }
  });

  it("accepts matching fingerprints but excludes internal diagnostics from detail", async () => {
    const config = TRACKED_META_BY_ID.get("hbd-hive")!.liveReservesConfig!;
    const db = fixture("hbd-hive", { freshnessMode: "not-applicable", diag: { durationMs: 123 }, supplyUsd: 456 }, computeLiveReserveConfigFingerprint(config));
    const detail = await resolveReserveResult(db, "hbd-hive", 1_200);
    expect(detail?.provenance?.scoringEligible).toBe(true);
    expect(detail?.metadata).toEqual({ freshnessMode: "not-applicable", supplyUsd: 456 });
  });

  it.each([null, "", "old-config", "G".repeat(64), "a".repeat(63)])("rejects missing or malformed composition binding %s even with current sync state", async (fingerprint) => {
    const config = TRACKED_META_BY_ID.get("hbd-hive")!.liveReservesConfig!;
    const composition = reserveCompositionRow({ stablecoin_id: "hbd-hive", source: config.adapter,
      config_fingerprint: fingerprint, metadata: JSON.stringify({ freshnessMode: "not-applicable" }) });
    const sync = reserveSyncRow({ stablecoin_id: "hbd-hive", adapter_key: config.adapter,
      config_fingerprint: computeLiveReserveConfigFingerprint(config) });
    const db = mockReserveD1([{ match: "reserve_composition", rows: [composition], first: composition },
      { match: "reserve_sync_state", rows: [sync], first: sync }]);
    const record = { stablecoinId: "hbd-hive", fetchedAt: 1_000, source: config.adapter,
      adapterSourceModel: "dynamic-mix" as const, adapterEvidenceClass: "independent" as const,
      slices: [{ name: "HBD", pct: 100, risk: "low" as const }], metadata: { freshnessMode: "not-applicable" as const },
      warnings: [], warningCount: 0, configFingerprint: fingerprint };
    expect(evaluateLiveReserveAdmission(record, { lastSuccessAt: 1_000, lastSuccessAttemptId: null },
      TRACKED_META_BY_ID.get("hbd-hive"), 1_200).reasons).toContain("config-mismatch");
    expect((await resolveReserveResult(db, "hbd-hive", 1_200))?.mode).not.toBe("live");
    expect((await loadFreshIndependentLiveReserveMap(db, 1_200)).has("hbd-hive")).toBe(false);
  });

  it.each(["usdy-ondo-finance", "usdt-tether"])("never marks suspended or unconfigured %s eligible", async (id) => {
    const meta = TRACKED_META_BY_ID.get(id)!;
    const runtimeMeta = WORKER_TRACKED_META_BY_ID.get(id)!;
    const originalRuntimeConfig = runtimeMeta.liveReservesConfig;
    const original = meta.liveReservesConfig;
    try {
      if (id === "usdt-tether") {
        delete meta.liveReservesConfig;
        delete runtimeMeta.liveReservesConfig;
      } else {
        const suspended = { reason: "test suspended feed", since: "2026-10-25" };
        meta.liveReservesConfig = { ...original!, suspended };
        runtimeMeta.liveReservesConfig = { ...originalRuntimeConfig!, suspended };
      }
      const retained = await resolveReserveResult(fixture(id), id, 1_200);
      expect(retained?.provenance?.scoringEligible).toBe(false);
      const staleRetained = await resolveReserveResult(fixture(id), id, 100_000, 100);
      expect(staleRetained?.mode).toBe("live-stale");
      expect(staleRetained?.reserves).toEqual(retained?.reserves);
      expect(staleRetained?.provenance?.scoringEligible).toBe(false);
      const fallback = await resolveReserveResult(mockReserveD1(), id, 1_200);
      expect(fallback).toMatchObject(getReserves(meta)!);
    } finally {
      meta.liveReservesConfig = original;
      runtimeMeta.liveReservesConfig = originalRuntimeConfig;
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

function row(slices: unknown[]) {
  return {
    stablecoin_id: "iusd-infinifi",
    slices: JSON.stringify(slices),
    fetched_at: 1_700_000_000,
    source: "infinifi",
    metadata: "{}",
    warnings: null as string | null,
    warning_count: 0 as number | null,
    adapter_source_model: "dynamic-mix" as string | null,
    adapter_evidence_class: "independent" as string | null,
  };
}

describe("stored live reserve dependency validation", () => {
  it.each([
    ["self target", [{ name: "Self", pct: 100, risk: "low", coinId: "iusd-infinifi" }]],
    ["unknown target", [{ name: "Unknown", pct: 100, risk: "low", coinId: "not-tracked" }]],
    ["depType without target", [{ name: "Missing", pct: 100, risk: "low", depType: "mechanism" }]],
  ])("rejects %s on D1 read", (_label, slices) => {
    expect(parseReserveCompositionRow(row(slices), null)).toEqual({
      record: null,
      issue: {
        code: "invalid-slice",
        message: "stored reserve snapshot contains invalid slice entries",
      },
    });
  });

  it("accepts a known tracked dependency target", () => {
    const parsed = parseReserveCompositionRow(
      row([{ name: "USDC", pct: 100, risk: "low", coinId: "usdc-circle", depType: "collateral" }]),
      null,
    );
    expect(parsed.issue).toBeNull();
    expect(parsed.record?.slices[0]).toMatchObject({ coinId: "usdc-circle", depType: "collateral" });
  });
});

describe("stored live reserve slice integrity", () => {
  it.each([
    ["invalid-json", "{not json"],
    ["invalid-payload", JSON.stringify({ name: "obj" })],
    ["empty-slices", "[]"],
    ["invalid-sum", JSON.stringify([{ name: "Cash", pct: 60, risk: "low" }])],
  ])("reports %s instead of returning a partial record", (code, slices) => {
    const parsed = parseReserveCompositionRow({ ...row([]), slices }, null);
    expect(parsed.record).toBeNull();
    expect(parsed.issue?.code).toBe(code);
  });

  it("falls back to the adapter definition for source model and evidence class, failing closed on unknown adapters", () => {
    const stored = { ...row([{ name: "Cash", pct: 100, risk: "low" }]), adapter_source_model: null, adapter_evidence_class: "nope" };
    const parsed = parseReserveCompositionRow(stored, null);
    expect(parsed.issue).toBeNull();
    expect(parsed.record).toMatchObject({ adapterSourceModel: expect.any(String), adapterEvidenceClass: expect.any(String) });

    const unknown = { ...stored, stablecoin_id: "not-tracked", source: "no-such-adapter" };
    expect(parseReserveCompositionRow(unknown, null).issue?.code).toBe("unknown-adapter-source");
  });

  it("decodes supported legacy warning severity and effect defaults without dropping members", () => {
    const coin = WORKER_TRACKED_META_BY_ID.get("iusd-infinifi")!;
    const parsed = parseReserveCompositionRow(
      { ...row([{ name: "Cash", pct: 100, risk: "low" }]),
        config_fingerprint: computeLiveReserveConfigFingerprint(coin.liveReservesConfig!),
        metadata: JSON.stringify({ freshnessMode: "not-applicable" }),
        warnings: JSON.stringify([
          { code: "stale", message: "source lagging", effect: "fatal" },
          { code: "note", message: "fyi", severity: "info" },
        ]), warning_count: null },
      null,
    );
    expect(parsed.record?.warnings).toEqual([
      { code: "stale", message: "source lagging", severity: "warning", effect: "fatal" },
      { code: "note", message: "fyi", severity: "info", effect: "info" },
    ]);
    expect(parsed.record?.warningCount).toBe(2);
    expect(parsed.issue).toBeNull();
    expect(evaluateLiveReserveAdmission(parsed.record, { lastSuccessAt: 1_700_000_000, lastSuccessAttemptId: null }, coin, 1_700_000_001))
      .toMatchObject({ eligible: false, reasons: ["degraded-snapshot"] });
  });

  it.each([
    ["not-json", 1], ["{}", 0], ["null", 0], ['[{"code":"material-unknown-exposure","effect":"degraded"}]', 1],
    ['[{"code":"gap","message":"gap","effect":"bogus"}]', 1], ["[]", 1],
    ['[{"code":"gap","message":"gap"}]', 0],
  ])("rejects warning corruption %s with a named integrity reason", (warnings, warning_count) => {
    const parsed = parseReserveCompositionRow({ ...row([{ name: "Cash", pct: 100, risk: "low" }]), warnings, warning_count }, null);
    expect(parsed.record).toBeNull();
    expect(parsed.issue?.code).toBe("invalid-warnings");
  });

  it.each([null, "[]"])("accepts legitimate empty warnings %s", (warnings) => {
    expect(parseReserveCompositionRow({ ...row([{ name: "Cash", pct: 100, risk: "low" }]), warnings }, null).issue).toBeNull();
  });
});

describe("stored live reserve snapshot metadata normalization", () => {
  it("quarantines the whole malformed telemetry claim rather than salvaging positive capacity", () => {
    const metadata = parseSnapshotMetadata(JSON.stringify({
      freshnessMode: "verified",
      details: { note: "kept" },
      redemption: {
        capacityUsd: 1_000,
        capacityRatioOfSupply: "0.5",
        feeBps: Number.NaN,
        capacityKind: "live-direct",
        freshnessKind: "not-a-kind",
        routeStatus: "open",
        routeStatusSource: "static-config",
        routeStatusReason: "reviewed",
        routeStatusReviewedAt: 42,
        holderEligibility: "verified-customer",
        sourceUrls: [
          "https://issuer.example/redeem",
          "https://issuer.example/redeem",
          "ftp://issuer.example/ignored",
          "not a url",
          7,
        ],
      },
    }));

    expect(metadata.freshnessMode).toBe("verified");
    expect(metadata.details).toEqual({ note: "kept" });
    expect(metadata.redemption?.capacityUsd).toBeUndefined();
    expect(Object.keys(metadata.redemption ?? {})).toEqual([]);
    expect(decodeLiveReserveRedemptionTelemetry(metadata).status).toBe("invalid");
    const reloaded = JSON.parse(JSON.stringify(metadata));
    expect(reloaded.redemption.capacityUsd).toBeUndefined();
  });

  it("treats a non-object redemption block as malformed and drops invalid top-level fields", () => {
    const metadata = parseSnapshotMetadata(JSON.stringify({
      freshnessMode: "bogus",
      details: ["not", "an", "object"],
      redemption: "bad",
    }));

    expect(metadata.freshnessMode).toBeUndefined();
    expect(metadata.details).toBeUndefined();
    expect(Object.keys(metadata.redemption ?? {})).toEqual([]);
    expect(decodeLiveReserveRedemptionTelemetry(metadata).status).toBe("invalid");

    const clean = parseSnapshotMetadata(JSON.stringify({ capacityUsd: 5 }));
    expect(clean.redemption).toBeUndefined();
    // Malformed JSON cannot establish freshness, so it is flagged as
    // invalid-freshness rather than silently dropped.
    expect(parseSnapshotMetadata("not json")).toEqual({ diag: { invalidFreshness: true } });
  });

  it("maps legacy flat capacity and fee fields into the nested redemption shape at decode time", () => {
    const metadata = parseSnapshotMetadata(JSON.stringify({
      freshnessMode: "not-applicable",
      immediateRedeemableUsd: 500_000,
      immediateRedeemableRatio: 0.25,
      redemptionFeeBps: 50,
    }));

    expect(metadata.immediateRedeemableUsd).toBeUndefined();
    expect(metadata.immediateRedeemableRatio).toBeUndefined();
    expect(metadata.redemptionFeeBps).toBeUndefined();
    expect(metadata.redemption).toEqual({
      capacityUsd: 500_000,
      capacityRatioOfSupply: 0.25,
      feeBps: 50,
    });
  });

  it("treats null legacy fields as unavailable while retaining valid legacy measured zero", () => {
    const absent = parseSnapshotMetadata(JSON.stringify({
      immediateRedeemableUsd: null, immediateRedeemableRatio: null, redemptionFeeBps: null,
    }));
    expect(decodeLiveReserveRedemptionTelemetry(absent).status).toBe("absent");
    expect(absent.redemption).toBeUndefined();
    const measured = parseSnapshotMetadata(JSON.stringify({
      immediateRedeemableUsd: 0, immediateRedeemableRatio: null, redemptionFeeBps: null,
    }));
    expect(decodeLiveReserveRedemptionTelemetry(measured)).toEqual({ status: "valid", telemetry: { capacityUsd: 0 } });
  });

  it("lets a nested redemption block win over legacy flat fields", () => {
    const metadata = parseSnapshotMetadata(JSON.stringify({
      freshnessMode: "not-applicable",
      immediateRedeemableUsd: 500_000,
      redemptionFeeBps: 50,
      redemption: {
        capacityUsd: 750_000,
        capacityKind: "live-direct-bounded",
        feeBps: 42,
      },
    }));

    expect(metadata.immediateRedeemableUsd).toBeUndefined();
    expect(metadata.redemptionFeeBps).toBeUndefined();
    expect(metadata.redemption).toMatchObject({
      capacityUsd: 750_000,
      capacityKind: "live-direct-bounded",
      feeBps: 42,
    });
  });

  it("quarantines malformed legacy flat fields without fabricating usable telemetry", () => {
    const metadata = parseSnapshotMetadata(JSON.stringify({
      freshnessMode: "not-applicable",
      immediateRedeemableUsd: "not-a-number",
      immediateRedeemableRatio: Number.NaN,
      redemptionFeeBps: "not-a-fee",
    }));

    expect(metadata.immediateRedeemableUsd).toBeUndefined();
    expect(metadata.immediateRedeemableRatio).toBeUndefined();
    expect(metadata.redemptionFeeBps).toBeUndefined();
    expect(decodeLiveReserveRedemptionTelemetry(metadata).status).toBe("invalid");
  });

  it.each([null, "0", -1])("preserves invalid supplied raw deviation %s but rejects the scoring row", (rawSumDeviation) => {
    const stored = { ...row([{ name: "Cash", pct: 100, risk: "low" }]),
      metadata: JSON.stringify({ diag: { rawSumDeviation, sourceDetail: "retained" } }) };
    expect(parseSnapshotMetadata(stored.metadata).diag).toEqual({ rawSumDeviation, sourceDetail: "retained" });
    const decoded = parseReserveCompositionRow(stored, null);
    expect(decoded.record).toBeNull();
    expect(decoded.issue?.code).toBe("invalid-payload");
  });

  it("preserves zero, extensions, and invalid nested precedence over a valid legacy claim", () => {
    const v9RouteAttempt = { status: "accepted", state: { observed: 0 } };
    expect(parseSnapshotMetadata(JSON.stringify({ redemption: { capacityUsd: 0, v9RouteAttempt } })).redemption)
      .toEqual({ capacityUsd: 0, v9RouteAttempt });
    const invalid = parseSnapshotMetadata(JSON.stringify({
      immediateRedeemableUsd: 1_000_000, redemption: { capacityUsd: 1_000, dailyLimitUsd: -1 },
    }));
    expect(invalid.redemption?.capacityUsd).toBeUndefined();
    expect(decodeLiveReserveRedemptionTelemetry(invalid).status).toBe("invalid");
  });

  it("accepts shared vocabularies while unknown nested values remain quarantined", () => {
    for (const adapter_source_model of LIVE_RESERVE_SOURCE_MODEL_VALUES) {
      for (const adapter_evidence_class of LIVE_RESERVE_EVIDENCE_CLASS_VALUES) {
        const decoded = parseReserveCompositionRow({
          ...row([{ name: "Cash", pct: 100, risk: "low" }]), adapter_source_model, adapter_evidence_class,
        }, null);
        expect(decoded.record).toMatchObject({ adapterSourceModel: adapter_source_model, adapterEvidenceClass: adapter_evidence_class });
      }
    }
    for (const effect of LIVE_RESERVE_WARNING_EFFECT_VALUES) {
      const decoded = parseReserveCompositionRow({ ...row([{ name: "Cash", pct: 100, risk: "low" }]),
        warning_count: 1, warnings: JSON.stringify([{ code: "source", message: "source issue", effect }]) }, null);
      expect(decoded.record?.warnings[0].effect).toBe(effect);
    }
    for (const freshnessMode of LIVE_RESERVE_FRESHNESS_MODE_VALUES) {
      expect(parseSnapshotMetadata(JSON.stringify({ freshnessMode })).freshnessMode).toBe(freshnessMode);
    }
    for (const [field, values] of [
      ["capacityKind", LIVE_RESERVE_REDEMPTION_CAPACITY_KIND_VALUES],
      ["freshnessKind", LIVE_RESERVE_REDEMPTION_FRESHNESS_KIND_VALUES],
      ["routeStatus", LIVE_RESERVE_REDEMPTION_ROUTE_STATUS_VALUES],
      ["routeStatusSource", LIVE_RESERVE_REDEMPTION_ROUTE_STATUS_SOURCE_VALUES],
    ] as const) {
      for (const value of values) {
        expect(parseSnapshotMetadata(JSON.stringify({ redemption: { [field]: value } })).redemption?.[field]).toBe(value);
      }
      expect(decodeLiveReserveRedemptionTelemetry(
        parseSnapshotMetadata(JSON.stringify({ redemption: { [field]: "unknown-value" } })),
      ).status).toBe("invalid");
    }
  });
});
