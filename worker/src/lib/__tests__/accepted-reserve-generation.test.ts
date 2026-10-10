import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import { beginLiveReserveCheckpoint } from "../scheduled-recovery-checkpoint";
import { ACCEPTED_RESERVE_GENERATION_KEY, acceptedReserveMetadataMap, assessConsumedRedemptionReserves, consumedReserveInput, loadAcceptedReserveGeneration, sealAcceptedReserveGeneration } from "../accepted-reserve-generation";
import { assessReserveSnapshotFreshness, evaluateLiveReserveAdmission } from "../live-reserves/store-snapshot-state";

const CLOCK = 1_790_000_000;
const ASSET = "iusd-infinifi";
const coin = ACTIVE_META_BY_ID.get(ASSET)!;
const fingerprint = computeLiveReserveConfigFingerprint(coin.liveReservesConfig!);
const openDatabases: Array<{ close(): void }> = [];
afterEach(() => { for (const sqlite of openDatabases.splice(0)) sqlite.close(); });

async function harness(slot = CLOCK, fetchedAt = CLOCK - 60) {
  const sqlite = createLatestSchemaSqlite().sqlite;
  openDatabases.push(sqlite);
  const db = createSqliteD1(sqlite);
  const identity = await beginLiveReserveCheckpoint(db, { slotStartedAt: slot, invocationId: `owner:${slot}`, nowSec: CLOCK });
  sqlite.prepare(`UPDATE worker_scheduled_checkpoints SET queue_hash = 'test', items_done = 2, items_total = 2, next_item_key = NULL, child_dispositions_json = '{"sync-live-reserves":"running"}' WHERE slot_started_at = ?`).run(slot);
  sqlite.prepare(`INSERT INTO reserve_composition (stablecoin_id, slices, fetched_at, source, attempt_id, metadata, warning_count, warnings, adapter_source_model, adapter_evidence_class, config_fingerprint) VALUES (?, ?, ?, ?, 'success', ?, 0, '[]', 'dynamic-mix', 'independent', ?)`).run(ASSET, '[{"name":"Cash","pct":100,"risk":"low"}]', fetchedAt, coin.liveReservesConfig!.adapter, '{"freshnessMode":"not-applicable","redemption":{"capacityUsd":1000000}}', fingerprint);
  sqlite.prepare(`INSERT INTO reserve_sync_state (stablecoin_id, adapter_key, breaker_key, last_attempted_at, last_success_at, last_status, warning_count, warnings, metadata, last_attempt_id, last_success_attempt_id) VALUES (?, ?, 'breaker', ?, ?, 'error', 0, '[]', '{}', 'failed-latest', 'success')`).run(ASSET, coin.liveReservesConfig!.adapter, CLOCK, fetchedAt);
  const ids = [ASSET, "missing-member"];
  return { sqlite, db, identity, ids };
}

describe("producer-owned accepted reserve generations", () => {
  it("seals a complete metadata census with retained successes and explicit absence", async () => {
    const h = await harness();
    const accepted = await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "degraded" }, CLOCK);
    expect(accepted?.members).toHaveLength(2);
    expect(accepted?.members[0]).toMatchObject({ stablecoinId: ASSET, snapshot: { attemptId: "success", sliceCount: 1 }, latestAttempt: { attemptId: "failed-latest", status: "error" } });
    expect(accepted?.members[1].snapshot).toBeNull();
    expect(h.sqlite.prepare("SELECT state, child_dispositions_json FROM worker_scheduled_checkpoints").get()).toMatchObject({ state: "running", child_dispositions_json: '{"sync-live-reserves":"completed"}' });
    const snapshot = accepted!.members[0].snapshot!;
    const full = { ...snapshot, slices: [{ name: "Cash", pct: 100, risk: "low" as const }] };
    expect(evaluateLiveReserveAdmission(snapshot, snapshot, coin, CLOCK)).toEqual(evaluateLiveReserveAdmission(full, snapshot, coin, CLOCK));
  });

  it.each([
    ["not-json", 1], ["{}", 0], ['[{"code":"material-unknown-exposure","effect":"degraded"}]', 1],
    ["[]", 1], ['[{"code":"note","message":"note","severity":"info"}]', 0],
  ])("uses the same strict warning-integrity boundary when sealing %s", async (warnings, count) => {
    const h = await harness();
    h.sqlite.prepare("UPDATE reserve_composition SET warnings = ?, warning_count = ?").run(warnings, count);
    const accepted = await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "ok" }, CLOCK);
    expect(accepted?.members[0].snapshot).toBeNull();
    expect(accepted?.members).toHaveLength(2);
  });

  it.each([
    null, [], "invalid",
    { capacityUsd: 1_000_000, dailyLimitUsd: -1 },
    { capacityUsd: 1_000_000, queueDepthUsd: null },
    { capacityUsd: 1_000_000, feeBps: 10_001 },
    { capacityUsd: 1_000_000, capacityRatioOfSupply: 1.01 },
    { capacityUsd: 1_000_000, outputAssetKeys: [] },
  ].map((redemption) => ({ redemption })))("keeps malformed nested telemetry unavailable after sealing and serialized reload: %j", async ({ redemption }) => {
    const h = await harness();
    h.sqlite.prepare("UPDATE reserve_composition SET metadata = ?").run(JSON.stringify({
      freshnessMode: "not-applicable", immediateRedeemableUsd: 2_000_000, redemption,
    }));
    await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "ok" }, CLOCK);
    const accepted = await loadAcceptedReserveGeneration(h.db);
    expect(accepted.members).toHaveLength(2);
    expect(accepted.members[0].snapshot).toBeNull();
    expect(acceptedReserveMetadataMap(accepted, CLOCK).has(ASSET)).toBe(false);
    expect(accepted.members[0].latestAttempt.status).toBe("error");
  });

  it("seals measured zero while unrelated malformed latest-attempt metadata cannot poison retained success", async () => {
    const h = await harness();
    h.sqlite.prepare("UPDATE reserve_composition SET metadata = ?").run(JSON.stringify({
      freshnessMode: "not-applicable", redemption: { capacityUsd: 0, dailyLimitUsd: 0 },
    }));
    h.sqlite.prepare("UPDATE reserve_sync_state SET metadata = ?").run(JSON.stringify({
      redemption: { capacityUsd: 1_000_000, dailyLimitUsd: -1 },
    }));
    const accepted = await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "degraded" }, CLOCK);
    expect(accepted?.members[0].snapshot?.metadata.redemption?.capacityUsd).toBe(0);
  });

  it.each([
    JSON.stringify({ freshnessMode: "not-applicable", redemption: { capacityUsd: 1_000_000, dailyLimitUsd: -1 } }),
    "invalid-json",
    "null",
  ])("quarantines malformed selected legacy state metadata: %s", async (metadata) => {
    const h = await harness();
    h.sqlite.prepare("UPDATE reserve_composition SET attempt_id = NULL, metadata = '{}'").run();
    h.sqlite.prepare("UPDATE reserve_sync_state SET last_success_attempt_id = NULL, last_attempted_at = last_success_at, last_status = 'ok', metadata = ?")
      .run(metadata);
    const accepted = await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "ok" }, CLOCK);
    expect(accepted?.members[0].snapshot).toBeNull();
  });

  it("preserves selected clean legacy state capacity through serialization", async () => {
    const h = await harness();
    h.sqlite.prepare("UPDATE reserve_composition SET attempt_id = NULL, metadata = '{}'").run();
    h.sqlite.prepare("UPDATE reserve_sync_state SET last_success_attempt_id = NULL, last_attempted_at = last_success_at, last_status = 'ok', metadata = ?")
      .run(JSON.stringify({ freshnessMode: "not-applicable", immediateRedeemableUsd: 1_000 }));
    await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "ok" }, CLOCK);
    expect((await loadAcceptedReserveGeneration(h.db)).members[0].snapshot?.metadata.redemption?.capacityUsd).toBe(1_000);
  });

  it.each([null, "0", -1])("does not seal malformed raw deviation %s as zero", async (rawSumDeviation) => {
    const h = await harness();
    h.sqlite.prepare("UPDATE reserve_composition SET metadata = ?").run(JSON.stringify({
      freshnessMode: "not-applicable", diag: { rawSumDeviation },
    }));
    const accepted = await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "ok" }, CLOCK);
    expect(accepted?.members[0].snapshot).toBeNull();
  });

  it.each([
    ["invocation_id = 'other'"], ["execution_generation = 2"], ["attempt_no = 2"], ["state = 'completed'"],
    ["queue_hash = 'other'"], ["items_total = 3"], ["items_done = 1"], ["next_item_key = 'pending'"],
    ["current_domain_attempt_id = 'pending'"], ["child_dispositions_json = '{\"sync-live-reserves\":\"failed\"}'"],
  ])("refuses changed ownership or incomplete frontier: %s", async (change) => {
    const h = await harness();
    h.sqlite.exec(`UPDATE worker_scheduled_checkpoints SET ${change}`);
    expect(await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "ok" }, CLOCK)).toBeNull();
    expect(h.sqlite.prepare("SELECT * FROM cache WHERE key = 'live-reserves:accepted-generation:v2'").get()).toBeUndefined();
  });

  it.each(["error", "skipped_locked", "skipped_neutral"] as const)("never seals an unsuccessful result: %s", async (status) => {
    const h = await harness();
    expect(await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status }, CLOCK)).toBeNull();
  });

  it("seals each root once and older compatible replay consumes retained newer acceptance", async () => {
    const h = await harness();
    const first = await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "ok" }, CLOCK);
    h.sqlite.prepare("UPDATE reserve_composition SET fetched_at = fetched_at + 1").run();
    const replay = await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "ok" }, CLOCK + 100);
    expect(replay).toEqual(first);
    const newer = await beginLiveReserveCheckpoint(h.db, { slotStartedAt: CLOCK + 14400, invocationId: "newer", nowSec: CLOCK });
    h.sqlite.prepare(`UPDATE worker_scheduled_checkpoints SET queue_hash = 'test', items_done = 2, items_total = 2, next_item_key = NULL, child_dispositions_json = '{"sync-live-reserves":"running"}' WHERE slot_started_at = ?`).run(newer.slotStartedAt);
    const latest = await sealAcceptedReserveGeneration(h.db, newer, "test", h.ids, { status: "ok" }, CLOCK + 14500);
    expect(await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "ok" }, CLOCK + 15000)).toEqual(latest);
  });

  it.each(["slices = 'invalid'", "metadata = 'invalid'", "warnings = '[{}]'", "adapter_evidence_class = 'invalid'"])("quarantines malformed members without losing the cohort: %s", async (change) => {
    const h = await harness();
    h.sqlite.exec(`UPDATE reserve_composition SET ${change}`);
    expect((await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "ok" }, CLOCK))?.members[0].snapshot).toBeNull();
  });

  it.each([null, "", "a".repeat(63), "G".repeat(64)])("keeps the full cohort while rejecting unbound fingerprint %s", async (configFingerprint) => {
    const h = await harness();
    h.sqlite.prepare("UPDATE reserve_composition SET config_fingerprint = ?").run(configFingerprint);
    const envelope = (await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "ok" }, CLOCK))!;
    expect(envelope.schemaVersion).toBe(2);
    expect(envelope.members.map((member) => member.stablecoinId)).toEqual(h.ids);
    expect(envelope.members[0].snapshot).toBeNull();
    expect((await loadAcceptedReserveGeneration(h.db)).members).toEqual(envelope.members);
  });

  it("never rereads v1 cache evidence and rejects a v1 envelope under the new key", async () => {
    const h = await harness();
    const envelope = (await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "ok" }, CLOCK))!;
    h.sqlite.prepare("UPDATE cache SET key = 'live-reserves:accepted-generation:v1', value = ?").run(JSON.stringify({ ...envelope, schemaVersion: 1 }));
    await expect(loadAcceptedReserveGeneration(h.db)).rejects.toThrow("accepted-reserve-view-unavailable");
    h.sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('live-reserves:accepted-generation:v2', ?, ?)").run(JSON.stringify({ ...envelope, schemaVersion: 1 }), CLOCK);
    await expect(loadAcceptedReserveGeneration(h.db)).rejects.toThrow("accepted-reserve-view-invalid");
  });

  it.each([
    "invalid-json", "{}", '{"root":null}', '{"root":"invalid"}',
    '{"root":{"slotStartedAt":"1790000000"}}',
  ])("repairs malformed prior acceptance through a fenced seal: %s", async (value) => {
    const h = await harness();
    h.sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run(ACCEPTED_RESERVE_GENERATION_KEY, value, CLOCK);
    await expect(loadAcceptedReserveGeneration(h.db)).rejects.toThrow("accepted-reserve-view-invalid");
    const accepted = await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "ok" }, CLOCK);
    expect(accepted?.root.slotStartedAt).toBe(CLOCK);
    expect(await loadAcceptedReserveGeneration(h.db)).toEqual(accepted);
    expect(await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "ok" }, CLOCK + 1)).toEqual(accepted);
  });

  it.each(["schema", "digest"] as const)("repairs an invalid %s even when its root clock is newer", async (invalidity) => {
    const h = await harness();
    const first = (await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "ok" }, CLOCK))!;
    const corrupt = {
      ...first, root: { ...first.root, slotStartedAt: CLOCK + 14400 },
      generationId: `reserve:${CLOCK + 14400}:test`,
      ...(invalidity === "schema" ? { schemaVersion: 1 } : { contentSha256: "0".repeat(64) }),
    };
    h.sqlite.prepare("UPDATE cache SET value = ? WHERE key = ?").run(JSON.stringify(corrupt), ACCEPTED_RESERVE_GENERATION_KEY);
    await expect(loadAcceptedReserveGeneration(h.db)).rejects.toThrow("accepted-reserve-view-invalid");
    const repaired = await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "ok" }, CLOCK + 1);
    expect(repaired?.root.slotStartedAt).toBe(CLOCK);
    expect(await loadAcceptedReserveGeneration(h.db)).toEqual(repaired);
  });

  it.each([null, "{}"])("supersedes a concurrently published older seal while repairing %s", async (prior) => {
    const h = await harness();
    const older = (await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "ok" }, CLOCK))!;
    if (prior === null) h.sqlite.prepare("DELETE FROM cache WHERE key = ?").run(ACCEPTED_RESERVE_GENERATION_KEY);
    else h.sqlite.prepare("UPDATE cache SET value = ? WHERE key = ?").run(prior, ACCEPTED_RESERVE_GENERATION_KEY);
    const newer = await beginLiveReserveCheckpoint(h.db, { slotStartedAt: CLOCK + 14400, invocationId: "newer", nowSec: CLOCK });
    h.sqlite.prepare(`UPDATE worker_scheduled_checkpoints SET queue_hash = 'test', items_done = 2, items_total = 2, next_item_key = NULL, child_dispositions_json = '{"sync-live-reserves":"running"}' WHERE slot_started_at = ?`).run(newer.slotStartedAt);
    const batch = h.db.batch.bind(h.db);
    const concurrentPublish = vi.spyOn(h.db, "batch").mockImplementationOnce((statements) => {
      h.sqlite.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
        .run(ACCEPTED_RESERVE_GENERATION_KEY, JSON.stringify(older), CLOCK);
      return batch(statements);
    });
    try {
      const accepted = await sealAcceptedReserveGeneration(h.db, newer, "test", h.ids, { status: "ok" }, CLOCK + 14500);
      expect(accepted?.root.slotStartedAt).toBe(newer.slotStartedAt);
      expect(await loadAcceptedReserveGeneration(h.db)).toEqual(accepted);
    } finally { concurrentPublish.mockRestore(); }
  });

  it.each([null, "{}"])("cannot replace a concurrently published newer valid seal while repairing %s", async (prior) => {
    const h = await harness();
    const newer = await beginLiveReserveCheckpoint(h.db, { slotStartedAt: CLOCK + 14400, invocationId: "newer", nowSec: CLOCK });
    h.sqlite.prepare(`UPDATE worker_scheduled_checkpoints SET queue_hash = 'test', items_done = 2, items_total = 2, next_item_key = NULL, child_dispositions_json = '{"sync-live-reserves":"running"}' WHERE slot_started_at = ?`).run(newer.slotStartedAt);
    const latest = (await sealAcceptedReserveGeneration(h.db, newer, "test", h.ids, { status: "ok" }, CLOCK + 14500))!;
    if (prior === null) h.sqlite.prepare("DELETE FROM cache WHERE key = ?").run(ACCEPTED_RESERVE_GENERATION_KEY);
    else h.sqlite.prepare("UPDATE cache SET value = ? WHERE key = ?").run(prior, ACCEPTED_RESERVE_GENERATION_KEY);
    const batch = h.db.batch.bind(h.db);
    const concurrentPublish = vi.spyOn(h.db, "batch").mockImplementationOnce((statements) => {
      h.sqlite.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
        .run(ACCEPTED_RESERVE_GENERATION_KEY, JSON.stringify(latest), CLOCK + 14500);
      return batch(statements);
    });
    try {
      expect(await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "ok" }, CLOCK + 15000)).toEqual(latest);
      expect(await loadAcceptedReserveGeneration(h.db)).toEqual(latest);
    } finally { concurrentPublish.mockRestore(); }
  });

  it("fails closed for absent, malformed and tampered envelopes", async () => {
    const h = await harness();
    await expect(loadAcceptedReserveGeneration(h.db)).rejects.toThrow("accepted-reserve-view-unavailable");
    await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "ok" }, CLOCK);
    h.sqlite.exec("UPDATE cache SET value = json_set(value, '$.producerCompletedAtSec', 1)");
    await expect(loadAcceptedReserveGeneration(h.db)).rejects.toThrow("accepted-reserve-view-invalid");
  });

  it("does not complete the producer child when acceptance persistence rolls back", async () => {
    const h = await harness();
    h.sqlite.exec("CREATE TRIGGER refuse_seal BEFORE INSERT ON cache BEGIN SELECT RAISE(ABORT, 'seal write failed'); END");
    await expect(sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "ok" }, CLOCK)).rejects.toThrow("seal write failed");
    expect(h.sqlite.prepare("SELECT child_dispositions_json FROM worker_scheduled_checkpoints").get()).toMatchObject({ child_dispositions_json: '{"sync-live-reserves":"running"}' });
  });

  it("reassesses consumed fetch clocks at the strict 48-hour boundary without renewing the run", async () => {
    const h = await harness(CLOCK, CLOCK - 48 * 3600 + 60);
    const accepted = (await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "ok" }, CLOCK))!;
    const record = acceptedReserveMetadataMap(accepted, CLOCK).get(ASSET)!;
    const input = consumedReserveInput(accepted, ASSET, record);
    const entries = [{ stablecoinId: ASSET, reserveInput: input }] as RedemptionBackstopEntry[];
    const metadata = { reserveViewSchemaVersion: 2, reserveGenerationId: accepted.generationId, reserveContentSha256: accepted.contentSha256, runClockSec: CLOCK, consumedReserveInputs: { [ASSET]: input } };
    const fresh = { state: "fresh", quarantined: {} };
    const unavailable = { state: "unavailable", quarantined: {} };
    expect(assessConsumedRedemptionReserves(entries, metadata, CLOCK, CLOCK + 59)).toEqual(fresh);
    expect(assessConsumedRedemptionReserves(entries, metadata, CLOCK, CLOCK + 60)).toEqual(fresh);
    expect(assessConsumedRedemptionReserves(entries, metadata, CLOCK, CLOCK + 61)).toEqual({ state: "fresh", quarantined: { [ASSET]: "stale" } });
    expect(assessConsumedRedemptionReserves(entries, {}, CLOCK, CLOCK)).toEqual(unavailable);
    expect(assessConsumedRedemptionReserves(entries, { ...metadata, consumedReserveInputs: {} }, CLOCK, CLOCK)).toEqual(unavailable);
  });

  it("expires consumed source evidence independently of a fresh fetch and checks binding identity", async () => {
    const h = await harness(CLOCK, CLOCK - 60);
    const accepted = (await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "ok" }, CLOCK))!;
    const input = consumedReserveInput(accepted, ASSET, acceptedReserveMetadataMap(accepted, CLOCK).get(ASSET)!);
    const budget = assessReserveSnapshotFreshness({ fetchedAt: CLOCK - 60, attemptId: "success", metadata: {
      freshnessMode: "verified", sourceTimestamp: CLOCK - 60,
    } }, coin, CLOCK, 172800).sourceAgeBudgetSec!;
    input.freshness = assessReserveSnapshotFreshness({ fetchedAt: CLOCK - 60, attemptId: "success", metadata: {
      freshnessMode: "verified", sourceTimestamp: CLOCK - budget + 60,
    } }, coin, CLOCK, 172800);
    const entries = [{ stablecoinId: ASSET, reserveInput: input }] as RedemptionBackstopEntry[];
    const metadata = { reserveViewSchemaVersion: 2, reserveGenerationId: accepted.generationId, reserveContentSha256: accepted.contentSha256, runClockSec: CLOCK, consumedReserveInputs: { [ASSET]: input } };
    expect(assessConsumedRedemptionReserves(entries, metadata, CLOCK, CLOCK + 60)).toEqual({ state: "fresh", quarantined: {} });
    expect(assessConsumedRedemptionReserves(entries, metadata, CLOCK, CLOCK + 61)).toEqual({ state: "fresh", quarantined: { [ASSET]: "stale" } });
    expect(assessConsumedRedemptionReserves(entries, { ...metadata, reserveGenerationId: "different" }, CLOCK, CLOCK).state).toBe("unavailable");
    expect(assessConsumedRedemptionReserves(entries, { ...metadata, consumedReserveInputs: { [ASSET]: { ...input, configFingerprint: "b".repeat(64) } } }, CLOCK, CLOCK).state).toBe("unavailable");
    // A consistent binding to a configuration that has since changed loses only that asset.
    const rebound = { ...input, configFingerprint: "b".repeat(64) };
    expect(assessConsumedRedemptionReserves([{ stablecoinId: ASSET, reserveInput: rebound }] as RedemptionBackstopEntry[],
      { ...metadata, consumedReserveInputs: { [ASSET]: rebound } }, CLOCK, CLOCK)).toEqual({ state: "fresh", quarantined: { [ASSET]: "config-mismatch" } });
  });
  it.each([
    [{ freshnessMode: "not-applicable" }, {}],
    [{ freshnessMode: "verified", sourceTimestamp: CLOCK - 60 }, {}],
    [{ freshnessMode: "unverified" }, { [ASSET]: "freshness-unverified" }],
    [{}, { [ASSET]: "freshness-unverified" }],
    [{ freshnessMode: "verified" }, { [ASSET]: "freshness-unverified" }],
    [{ freshnessMode: "not-applicable", diag: { invalidFreshness: true } }, { [ASSET]: "freshness-unverified" }],
  ] as const)("preserves captured source mode and diagnosis through seal and consumed readback: %j", async (sourceMetadata, quarantined) => {
    const h = await harness();
    h.sqlite.prepare("UPDATE reserve_composition SET metadata = ?").run(JSON.stringify(sourceMetadata));
    await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "ok" }, CLOCK);
    const envelope = await loadAcceptedReserveGeneration(h.db);
    const input = consumedReserveInput(envelope, ASSET, acceptedReserveMetadataMap(envelope, CLOCK).get(ASSET)!);
    expect(input.freshness.freshnessMode).toBe("freshnessMode" in sourceMetadata ? sourceMetadata.freshnessMode : null);
    expect(input.freshness.sourceFreshnessInvalid).toBe("diag" in sourceMetadata);
    const entries = [{ stablecoinId: ASSET, reserveInput: input }] as RedemptionBackstopEntry[];
    const metadata = { reserveViewSchemaVersion: 2, reserveGenerationId: envelope.generationId, reserveContentSha256: envelope.contentSha256,
      runClockSec: CLOCK, consumedReserveInputs: { [ASSET]: input } };
    expect(assessConsumedRedemptionReserves(entries, JSON.parse(JSON.stringify(metadata)), CLOCK, CLOCK)).toEqual({ state: "fresh", quarantined });
    expect(assessConsumedRedemptionReserves(entries, { ...metadata, reserveViewSchemaVersion: 1 }, CLOCK, CLOCK).state).toBe("unavailable");
    const { freshnessMode: _mode, ...modeLessFreshness } = input.freshness;
    const oldInput = { ...input, freshness: modeLessFreshness };
    expect(assessConsumedRedemptionReserves([{ ...entries[0], reserveInput: oldInput }] as RedemptionBackstopEntry[],
      { ...metadata, consumedReserveInputs: { [ASSET]: oldInput } }, CLOCK, CLOCK).state).toBe("unavailable");
  });

  it("rejects future Worker fetch clocks before and after consumed round-trip", async () => {
    const h = await harness(CLOCK, CLOCK + 1);
    const envelope = (await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "ok" }, CLOCK))!;
    const record = acceptedReserveMetadataMap(envelope, CLOCK).get(ASSET)!;
    expect(record.admission?.reasons).toEqual(expect.arrayContaining(["stale", "invalid-freshness"]));
    expect(record.admission?.freshness).toMatchObject({ fetchAgeSec: -1, staleReasons: ["invalid-fetch-clock"] });
    const input = consumedReserveInput(envelope, ASSET, record);
    const metadata = { reserveViewSchemaVersion: 2, reserveGenerationId: envelope.generationId, reserveContentSha256: envelope.contentSha256,
      runClockSec: CLOCK, consumedReserveInputs: { [ASSET]: input } };
    expect(assessConsumedRedemptionReserves([{ stablecoinId: ASSET, reserveInput: input }] as RedemptionBackstopEntry[], metadata, CLOCK, CLOCK).state).toBe("unavailable");
  });
});
