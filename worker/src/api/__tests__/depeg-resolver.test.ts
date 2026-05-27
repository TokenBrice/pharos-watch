import { afterEach, describe, expect, it, vi } from "vitest";
import { handleDepegResolver } from "../depeg-resolver";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import {
  DDR_METHODOLOGY_VERSION,
  DDR_METHODOLOGY_VERSION_LABEL,
  DDR_PREDICTION_POLICY_VERSION,
  DDR_SNAPSHOT_CACHE_GENERATION as DDR_PUBLIC_SNAPSHOT_CACHE_GENERATION,
} from "@shared/lib/depeg-resolver-version";
import { buildDdrManifestBasePayload, computeDdrManifestBasePayloadHash } from "@shared/lib/depeg-resolver/public-contract";
import { DDR_SNAPSHOT_CACHE_GENERATION as DDR_CACHE_ENVELOPE_GENERATION } from "../../lib/depeg-resolver-snapshot-cache";
import type {
  DdrPredictionMeta,
  DdrResponse,
  DdrV2LiveOverlay,
  DdrV2PredictionRow,
  DdrV2ResponseRow,
} from "@shared/types/depeg-resolver";

afterEach(() => {
  vi.useRealTimers();
});

const ROW_HASH = "2".repeat(64);

function basePredictionMeta(
  computedAt: number,
  overrides: Partial<DdrPredictionMeta> = {},
): DdrPredictionMeta {
  return {
    state: "frozen",
    publicPredictionId: 7,
    incidentKey: "ddr2:11111111111111111111111111111111",
    predictionPolicyVersion: DDR_PREDICTION_POLICY_VERSION,
    predictionMethodologyVersion: DDR_METHODOLOGY_VERSION,
    predictionMethodologyVersionLabel: DDR_METHODOLOGY_VERSION_LABEL,
    resolutionRubricVersion: "resolution-rubric-v1",
    durationModelVersion: "duration-landmark-v1",
    incidentGroupingVersion: "incident-group-v1",
    supportRulesVersion: "support-rules-v1",
    eligibleAt: computedAt - 24 * 3600,
    lockedAt: computedAt - 23 * 3600,
    publishedAt: computedAt - 22 * 3600,
    publicationSnapshotToken: "ddrpub_001",
    snapshotGeneration: DDR_PUBLIC_SNAPSHOT_CACHE_GENERATION,
    eventAgeAtLockSec: 24 * 3600,
    lockTiming: "on_time",
    source: "public_prediction",
    deferralReason: null,
    deferralCount: null,
    rowHash: ROW_HASH,
    lineage: null,
    modelAsOf: computedAt,
    latestErratum: null,
    errataCount: 0,
    errataHistory: [],
    ...overrides,
  };
}

function live(computedAt: number, overrides: Partial<DdrV2LiveOverlay> = {}): DdrV2LiveOverlay {
  return {
    currentEventId: 1,
    ageSec: 3600,
    peakDeviationBps: -300,
    currentDeviationBps: -250,
    eventState: "active",
    updatedAt: computedAt,
    stale: false,
    degradedReason: null,
    ...overrides,
  };
}

function predictionRow(computedAt: number): DdrV2PredictionRow & { live: DdrV2LiveOverlay } {
  const prediction = {
    ...basePredictionMeta(computedAt),
    state: "frozen" as const,
  };
  return {
    stablecoinId: "lusd-liquity",
    symbol: "LUSD",
    name: "Liquity USD",
    pegCurrency: "USD",
    governance: "decentralized",
    status: null,
    eventId: 1,
    incidentKey: "ddr2:11111111111111111111111111111111",
    startedAt: computedAt - 27 * 3600,
    direction: "below",
    kind: "prediction",
    prediction,
    frozen: {
      resolution: { tier: "at_risk", factors: [] },
      duration: {
        suppressed: false,
        suppressedReason: null,
        stratum: "below - moderate - robust - USD",
        medianSec: 3600,
        iqrSec: [1800, 7200],
        ageStatus: "ordinary",
        remainingAsOf: computedAt - 23 * 3600,
        medianResolveAt: computedAt - 22 * 3600,
        iqrResolveAt: [computedAt - 22.5 * 3600, computedAt - 21 * 3600],
        horizons: [
          {
            horizon: "6h",
            state: "thin_support",
            probability: 0.5,
            probabilityDisplay: "35-65%",
            probabilityInterval: { lower: 0.35, upper: 0.65 },
            rawAtRisk: 12,
            uniqueCoins: 6,
            intervalClosures: 6,
            intervalNonClosures: 6,
            horizonEndAt: computedAt - 17 * 3600,
            anchoredLabel: "within 6h of lock",
          },
        ],
      },
      relatedContext: {
        dewsBand: null,
        dewsScore: null,
        liquidityScore: null,
        safetyGrade: null,
        safetyScore: null,
        supplyChange7dPct: null,
        supplyChange30dPct: null,
        mintSurge: null,
      },
      sourceRow: {
        stablecoinId: "lusd-liquity",
        symbol: "LUSD",
        name: "Liquity USD",
        pegCurrency: "USD",
        governance: "decentralized",
        status: null,
        eventId: 1,
        startedAt: computedAt - 27 * 3600,
        ageSec: 24 * 3600,
        direction: "below",
        peakDeviationBps: -300,
        currentDeviationBps: -250,
        resolution: { tier: "at_risk", factors: [] },
        duration: {
          suppressed: false,
          suppressedReason: null,
          stratum: "below - moderate - robust - USD",
          medianSec: 3600,
          iqrSec: [1800, 7200],
          ageStatus: "ordinary",
          horizons: [],
        },
        relatedContext: {
          dewsBand: null,
          dewsScore: null,
          liquidityScore: null,
          safetyGrade: null,
          safetyScore: null,
          supplyChange7dPct: null,
          supplyChange30dPct: null,
          mintSurge: null,
        },
      },
    },
    live: live(computedAt),
  };
}

function snapshot(computedAt: number, expiresAt: number, rows: DdrResponse["rows"] = [predictionRow(computedAt)]): DdrResponse {
  const payload: DdrResponse = {
    _meta: {
      schemaVersion: 2,
      dataAsOf: computedAt,
      modelAsOf: computedAt,
      computedAt,
      expiresAt,
      snapshotToken: "ddrpub_001",
      snapshotGeneration: DDR_PUBLIC_SNAPSHOT_CACHE_GENERATION,
      publicPredictionIds: [7],
      publicPredictionRowHashes: { "7": ROW_HASH },
      basePayloadHash: null,
      readOverlay: {
        degradedLockDeferralIncidentKeys: [],
        closedPendingReviewIncidentKeys: [],
        suppressedIncidentKeys: [],
      },
      degraded: false,
      degradedReason: null,
      publicWarning: "warning",
      resolutionRubricVersion: "resolution-rubric-v1",
      durationModelVersion: "duration-landmark-v1",
      incidentGroupingVersion: "incident-group-v1",
      supportRulesVersion: "support-rules-v1",
      lineage: null,
    },
    rows,
    methodology: {
      version: DDR_METHODOLOGY_VERSION,
      versionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      currentVersion: DDR_METHODOLOGY_VERSION,
      currentVersionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      changelogPath: "/methodology/depeg-resolver-changelog/",
      asOf: computedAt,
      isCurrent: true,
    },
  };
  payload._meta.basePayloadHash = computeDdrManifestBasePayloadHash(payload);
  return payload;
}

function cacheRows(payload: DdrResponse) {
  return [
    {
      match: "FROM cache WHERE key = ?",
      rows: [
        {
          key: "depeg-resolver:snapshot",
          value: JSON.stringify({
            generation: DDR_CACHE_ENVELOPE_GENERATION,
            methodologyVersion: DDR_METHODOLOGY_VERSION,
            payload,
          }),
          updated_at: payload._meta.computedAt,
        },
      ],
    },
  ];
}

function manifestRow(payload: DdrResponse, sequence = 1) {
  return {
    snapshot_token: payload._meta.snapshotToken,
    snapshot_kind: "ddr_public",
    snapshot_sequence: sequence,
    snapshot_generation: payload._meta.snapshotGeneration,
    published_at: payload._meta.computedAt,
    base_payload_hash: payload._meta.basePayloadHash,
    public_prediction_ids_hash: "a".repeat(64),
    public_prediction_ids_json: JSON.stringify(payload._meta.publicPredictionIds),
    public_prediction_row_hashes_json: JSON.stringify(payload._meta.publicPredictionRowHashes),
    base_payload_json: JSON.stringify(buildDdrManifestBasePayload(payload)),
    base_row_count: payload.rows.length,
    public_prediction_count: payload._meta.publicPredictionIds.length,
    created_at: payload._meta.computedAt,
    finalized_at: payload._meta.computedAt,
    validator_version: "vitest",
  };
}

describe("handleDepegResolver", () => {
  it("serves stale v2 snapshots as degraded while preserving frozen duration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000 * 1000);
    const payload = snapshot(1_998_000, 1_999_000);
    const db = mockD1(cacheRows(payload));

    const res = await handleDepegResolver(db);
    const body = (await res.json()) as DdrResponse;

    expect(res.status).toBe(200);
    expect(body._meta.schemaVersion).toBe(2);
    expect(body._meta.degraded).toBe(true);
    expect(body._meta.degradedReason).toBe("stale-cache");
    expect(body.rows[0].kind).toBe("prediction");
    expect(body.rows[0].live.stale).toBe(true);
    if (body.rows[0].kind !== "prediction") throw new Error("expected prediction row");
    expect(body.rows[0].frozen.duration.medianSec).toBe(3600);
    expect(body.rows[0].frozen.duration.horizons).toHaveLength(1);
  });

  it("marks stale closed rows as awaiting DDRR handoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000 * 1000);
    const payload = snapshot(1_998_000, 1_999_000);
    const db = mockD1([
      ...cacheRows(payload),
      { match: "FROM depeg_events WHERE id IN", rows: [{ id: 1, ended_at: 1_999_500 }] },
    ]);

    const res = await handleDepegResolver(db);
    const body = (await res.json()) as DdrResponse;

    expect(res.status).toBe(200);
    expect(body.rows[0].live.eventState).toBe("closed_pending_review");
    expect(body._meta.readOverlay.closedPendingReviewIncidentKeys).toContain("ddr2:11111111111111111111111111111111");
  });

  it("falls back to the latest finalized manifest when cache metadata is behind", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000 * 1000);
    const cached = snapshot(1_998_000, 2_001_000);
    const latest = snapshot(1_999_000, 2_002_000);
    latest._meta.snapshotToken = "ddrpub_002";
    latest.rows[0].prediction.publicationSnapshotToken = "ddrpub_002";
    latest._meta.basePayloadHash = computeDdrManifestBasePayloadHash(latest);
    const db = mockD1([
      ...cacheRows(cached),
      { match: "FROM depeg_resolver_publication_snapshots", rows: [manifestRow(latest, 2)] },
    ]);

    const res = await handleDepegResolver(db);
    const body = (await res.json()) as DdrResponse;

    expect(res.status).toBe(200);
    expect(body._meta.snapshotToken).toBe("ddrpub_002");
    expect(body._meta.degradedReason).toBe("manifest-fallback:cache-manifest-token-behind");
    expect(body.rows[0].live.currentEventId).toBeNull();
    expect(body.rows[0].live.eventState).toBe("source_event_missing");
  });

  it("returns degraded when the cache base payload hash does not match", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000 * 1000);
    const payload = snapshot(1_998_000, 1_999_000);
    payload._meta.basePayloadHash = "0".repeat(64);
    const db = mockD1(cacheRows(payload));

    const res = await handleDepegResolver(db);
    const body = (await res.json()) as DdrResponse;

    expect(res.status).toBe(200);
    expect(body._meta.degraded).toBe(true);
    expect(body._meta.degradedReason).toBe("base-payload-hash-mismatch");
    expect(body.rows).toEqual([]);
  });

  it("keeps publication-retry-pending placeholders free of frozen payloads", async () => {
    const computedAt = 1_998_000;
    const prediction = {
      ...basePredictionMeta(computedAt),
      state: "publication_retry_pending" as const,
      publicPredictionId: null,
      publishedAt: null,
      publicationSnapshotToken: null,
      snapshotGeneration: null,
      rowHash: null,
      source: "pending" as const,
    };
    const pendingRow: DdrV2ResponseRow = {
      stablecoinId: "lusd-liquity",
      symbol: "LUSD",
      name: "Liquity USD",
      pegCurrency: "USD",
      governance: "decentralized",
      status: null,
      eventId: 1,
      incidentKey: "ddr2:11111111111111111111111111111111",
      startedAt: computedAt - 27 * 3600,
      direction: "below",
      kind: "pending",
      prediction,
      frozen: null,
      live: live(computedAt),
    };

    expect(pendingRow.kind).toBe("pending");
    expect(pendingRow.prediction.state).toBe("publication_retry_pending");
    expect(pendingRow.frozen).toBeNull();
    expect("resolution" in pendingRow).toBe(false);
    expect("duration" in pendingRow).toBe(false);
  });
});
