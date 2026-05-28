import {
  DDR_ERRATUM_REASON_VALUES,
  DDR_PUBLIC_WARNING,
  type DdrResponse,
  type DdrPredictionErratum,
  type DdrRow,
} from "@shared/types/depeg-resolver";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import {
  attachDdrPublicRowHash,
  buildDdrManifestBasePayload,
  computeDdrPublicRowHash,
} from "@shared/lib/depeg-resolver/public-contract";
import {
  DDR_DURATION_MODEL_VERSION,
  DDR_INCIDENT_GROUPING_VERSION,
  DDR_LOCK_ON_TIME_GRACE_SEC,
  DDR_METHODOLOGY_CHANGELOG_PATH,
  DDR_METHODOLOGY_VERSION,
  DDR_METHODOLOGY_VERSION_LABEL,
  DDR_PREDICTION_POLICY_VERSION,
  DDR_PUBLIC_PREDICTION_DELAY_SEC,
  DDR_RESOLUTION_RUBRIC_VERSION,
  DDR_SNAPSHOT_CACHE_GENERATION,
  DDR_SUPPORT_RULES_VERSION,
  DDR_V2_EFFECTIVE_AT,
} from "@shared/lib/depeg-resolver-version";
import { derivePegRates, getPegReference } from "@shared/lib/peg-rates";
import {
  groupIncidents,
  quarantinedCoins,
  resolveDepeg,
  structuralClass,
  type DdrActiveEventInput,
  type DdrCoinStructural,
  type DdrHistoricalEvent,
  type DdrIncident,
  type DdrLiveContext,
  type DdrSupplyContext,
} from "@shared/lib/depeg-resolver";
import { TRACKED_META_BY_ID, FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import { isTerminalStablecoinStatus } from "@shared/lib/stablecoin-lifecycle";
import type { StablecoinMeta } from "@shared/types/core";
import { sumPegBuckets } from "@shared/lib/supply";
import type { StablecoinData } from "@shared/types/market";
import { buildMethodologyEnvelope } from "../lib/api-utils";
import type { CronResult } from "../lib/cron-logger";
import { computeAndStoreDepegResolverReview } from "./compute-depeg-resolver-review";
import {
  DDR_PUBLICATION_SNAPSHOT_KIND,
  type DdrCanonicalIncident,
  type DdrCanonicalIncidentInput,
  type DdrDirection,
  type DdrFirstPublicationMembership,
  type DdrLockTiming,
  type DdrPublicationManifest,
  type DdrSealedPublicPrediction,
  type DdrSealInput,
  type DdrV2StoreContracts,
} from "./depeg-resolver-v2-contracts";
import { writeDepegResolverAssessments } from "../lib/depeg-resolver-assessment-store";
import {
  ensureCanonicalIncidents as ensureCanonicalIncidentsStore,
  loadCanonicalIncidents as loadCanonicalIncidentsStore,
  recordLockDeferral as recordLockDeferralStore,
  recordLockOpportunity as recordLockOpportunityStore,
  type DdrCanonicalIncident as StoreDdrCanonicalIncident,
  type DdrCanonicalIncidentEventInput as StoreDdrCanonicalIncidentEventInput,
} from "../lib/depeg-resolver-incident-store";
import {
  loadFirstPublicationMembership as loadFirstPublicationMembershipStore,
  loadLatestPublicationManifest as loadLatestPublicationManifestStore,
  loadSealedPublicPredictions as loadSealedPublicPredictionsStore,
  sealPublicNoCall as sealPublicNoCallStore,
  sealPublicPrediction as sealPublicPredictionStore,
  writePublicationManifest as writePublicationManifestStore,
  type DdrFirstPublicationMembership as StoreDdrFirstPublicationMembership,
  type DdrPublicAssessmentSealInput as StoreDdrPublicAssessmentSealInput,
  type DdrPublicationManifest as StoreDdrPublicationManifest,
  type DdrSealedPublicPrediction as StoreDdrSealedPublicPrediction,
} from "../lib/depeg-resolver-publication-store";
import { loadPredictionErrata as loadPredictionErrataStore } from "../lib/depeg-resolver-errata-store";
import { writeDepegResolverSnapshot } from "../lib/depeg-resolver-snapshot-cache";
import { deriveDepegSignal } from "../lib/depeg-signals";
import { hasUsableStablecoinsPayload, loadStablecoinsCache } from "../lib/stablecoins-cache";

export type { DdrV2StoreContracts } from "./depeg-resolver-v2-contracts";

const TRAINING_WINDOW_SEC = 4 * 365 * 86400;
const HISTORICAL_ROW_CAP = 60000;
const DAY = 86400;
const CURRENT_PRICE_MAX_AGE_SEC = API_FRESHNESS_MAX_AGE_SEC.stablecoins;
const DEWS_MAX_AGE_SEC = API_FRESHNESS_MAX_AGE_SEC.stressSignals;
const DEX_LIQUIDITY_MAX_AGE_SEC = API_FRESHNESS_MAX_AGE_SEC.dexLiquidity;
const REDEMPTION_BACKSTOP_MAX_AGE_SEC = API_FRESHNESS_MAX_AGE_SEC.redemptionBackstops;

export interface ComputeDepegResolverV2Options {
  db: D1Database;
  signal?: AbortSignal;
  ddrRunId?: string;
  runAt?: number;
  slot?: string;
  stablecoinsCacheSafe?: boolean;
  depegPipelineHealthy?: boolean;
  syncCapabilities?: Record<string, unknown>;
  storeContracts?: DdrV2StoreContracts | null;
}

interface DdrEventDbRow {
  id: number;
  stablecoin_id: string;
  symbol: string;
  peg_type: string;
  direction: string;
  peak_deviation_bps: number;
  started_at: number;
  ended_at: number | null;
  recovery_price: number | null;
  peg_reference: number;
  source: string | null;
  confirmation_sources: string | null;
  pending_reason: string | null;
  provenance_replay_run_id: string | null;
  provenance_replay_version: string | null;
}

interface CurrentDeviationMapResult {
  byCoin: Map<string, number | null>;
  healthy: boolean;
  degradedReason: string | null;
  dataAsOf: number | null;
}

interface QueryRowsResult<T> {
  rows: T[];
  error: string | null;
}

interface DdrPendingPromotionOutcomeRow {
  stablecoin_id: string;
  peg_type: string;
  direction: string;
  first_seen_at: number;
  outcome_at: number;
}

type DdrDiagnosticResponse = Omit<DdrResponse, "rows"> & { rows: DdrRow[] };

function abortIf(signal: AbortSignal | undefined, label: string): void {
  if (signal?.aborted) throw signal.reason ?? new Error(`${label} aborted`);
}

function pegCurrencyFromPegType(pegType: string): string {
  return pegType.startsWith("pegged") ? pegType.slice("pegged".length) : "USD";
}

function toStructural(meta: StablecoinMeta): DdrCoinStructural {
  return {
    id: meta.id,
    symbol: meta.symbol,
    name: meta.name,
    pegCurrency: meta.flags.pegCurrency,
    governance: meta.flags.governance,
    status: meta.status ?? null,
    mechanismArchetype: meta.mechanismArchetype ?? null,
    mintPath: meta.mintAuthority?.mintPath ?? null,
    authorityPosture: meta.mintAuthority?.authorityPosture ?? null,
    mintConfidence: meta.mintAuthority?.confidence ?? null,
    collateralQuality: meta.collateralQuality ?? null,
    custodyModel: meta.custodyModel ?? null,
    deploymentModel: meta.deploymentModel ?? null,
    governanceQuality: meta.governanceQuality ?? null,
    reserves: meta.reserves?.map((r) => ({ risk: r.risk, pct: r.pct })),
    canBeBlacklisted: meta.canBeBlacklisted ?? null,
    dependencyImpaired: meta.dependencies?.some((d) => FROZEN_IDS.has(d.id) && d.weight >= 0.3) ?? false,
  };
}

function fallbackStructural(id: string, symbol: string, pegType: string): DdrCoinStructural {
  return {
    id,
    symbol,
    name: symbol,
    pegCurrency: pegCurrencyFromPegType(pegType),
    governance: "centralized",
  };
}

function randomHex(bytes: number): string {
  const data = new Uint8Array(bytes);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(data);
  } else {
    for (let index = 0; index < data.length; index += 1) {
      data[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(data, (value) => value.toString(16).padStart(2, "0")).join("");
}

function allocateDdrRunId(slot: string, runAt: number): string {
  return `ddr:${slot}:${runAt}:${randomHex(6)}`;
}

function safeJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function nullableStringValue(value: unknown, fallback: string | null): string | null {
  return value == null || typeof value === "string" ? value ?? fallback : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableNumberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function publicPredictionIdOf(row: DdrSealedPublicPrediction | StoreDdrSealedPublicPrediction): number {
  return "publicPredictionId" in row && row.publicPredictionId != null ? row.publicPredictionId : row.id;
}

function mapStoreIncident(row: StoreDdrCanonicalIncident): DdrCanonicalIncident {
  return {
    incidentKey: row.incidentKey,
    eventId: row.eventId,
    currentEventId: row.currentEventId,
    stablecoinId: row.stablecoinId,
    pegCurrency: row.pegCurrency,
    direction: row.direction,
    startedAt: row.startedAt,
    eligibleAt: row.eligibleAt,
    policyUniverseIncluded: row.policyUniverseIncluded,
    rolloutActiveAtEnablement: row.rolloutActiveAtEnablement,
    confirmedAt: row.confirmedAt,
    lockState: row.lockState,
  };
}

function mapStoreSealedPublicPrediction(row: StoreDdrSealedPublicPrediction): DdrSealedPublicPrediction {
  return {
    id: row.id,
    publicPredictionId: row.id,
    incidentKey: row.incidentKey,
    eventId: row.eventId,
    assessmentId: row.assessmentId,
    outcomeKind: row.outcomeKind,
    predictionPolicyVersion: row.predictionPolicyVersion,
    predictionMethodologyVersion: row.predictionMethodologyVersion,
    policyDelaySec: row.policyDelaySec,
    eligibleAt: row.eligibleAt,
    lockedAt: row.lockedAt,
    eventAgeAtLockSec: row.eventAgeAtLockSec,
    lockTiming: row.lockTiming,
    rowHash: row.rowHash,
    sealedPayload: row.sealedPayload ?? safeJsonObject(row.sealedPayloadJson),
  };
}

function mapStoreFirstPublication(row: StoreDdrFirstPublicationMembership): DdrFirstPublicationMembership {
  return {
    publicPredictionId: row.publicPredictionId,
    incidentKey: row.incidentKey,
    snapshotToken: row.snapshotToken,
    snapshotGeneration: row.snapshotGeneration,
    publishedAt: row.publishedAt,
    firstPublished: true,
  };
}

function mapStorePublicationManifest(row: StoreDdrPublicationManifest): DdrPublicationManifest {
  return {
    snapshotToken: row.snapshotToken,
    snapshotGeneration: row.snapshotGeneration,
    snapshotSequence: row.snapshotSequence,
    publishedAt: row.publishedAt,
    basePayloadHash: row.basePayloadHash,
    publicPredictionIds: row.publicPredictionIds,
    firstPublishedPublicPredictionIds: row.publicPredictionIds,
  };
}

function toStoreCanonicalIncidentInput(input: DdrCanonicalIncidentInput): StoreDdrCanonicalIncidentEventInput {
  const sourceFingerprint = input.sourceFingerprint?.trim().toLowerCase();
  return {
    eventId: input.eventId,
    stablecoinId: input.stablecoinId,
    pegCurrency: input.pegCurrency,
    direction: input.direction,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    peakDeviationBps: input.peakDeviationBps,
    source: input.source,
    sourceFingerprint: sourceFingerprint && /^[0-9a-f]{64}$/.test(sourceFingerprint) ? sourceFingerprint : null,
    publicTrackedAtFirstSeen: input.publicTrackedAtFirstSeen,
    psiShadowAtFirstSeen: input.psiShadowAtFirstSeen,
    registrySnapshot: input.registrySnapshot,
  };
}

function buildStoreRowHash(input: DdrSealInput): string {
  return computeDdrPublicRowHash(input.sealedPayload);
}

function toStoreSealInput(input: DdrSealInput): StoreDdrPublicAssessmentSealInput {
  const iqrSec = input.row.duration.iqrSec ?? null;
  const rowHash = buildStoreRowHash(input);
  return {
    incidentKey: input.incidentKey,
    eventId: input.eventId,
    stablecoinId: input.row.stablecoinId,
    symbol: input.row.symbol,
    name: input.row.name,
    pegCurrency: input.row.pegCurrency,
    governance: input.row.governance,
    direction: input.row.direction,
    startedAt: input.row.startedAt,
    assessedAt: input.lockedAt,
    eventAgeSec: input.eventAgeAtLockSec,
    methodologyVersion: input.methodologyVersion,
    methodologyVersionLabel: input.methodologyVersionLabel,
    resolutionRubricVersion: input.resolutionRubricVersion,
    durationModelVersion: input.durationModelVersion,
    incidentGroupingVersion: input.incidentGroupingVersion,
    supportRulesVersion: input.supportRulesVersion,
    resolutionTier: input.row.resolution.tier,
    durationSuppressed: input.row.duration.suppressed,
    durationSuppressedReason: input.row.duration.suppressedReason ?? null,
    medianRemainingSec: input.row.duration.medianSec ?? null,
    iqrLowRemainingSec: iqrSec?.[0] ?? null,
    iqrHighRemainingSec: iqrSec?.[1] ?? null,
    stratum: input.row.duration.stratum ?? null,
    horizons: input.row.duration.horizons,
    factors: input.row.resolution.factors,
    sealedPayload: attachDdrPublicRowHash(input.sealedPayload, rowHash),
    rowHash,
    predictionPolicyVersion: input.predictionPolicyVersion,
    policyDelaySec: input.policyDelaySec,
    eligibleAt: input.eligibleAt,
    lockedAt: input.lockedAt,
    eventAgeAtLockSec: input.eventAgeAtLockSec,
    lockTiming: input.lockTiming,
    createdAt: input.lockedAt,
    runId: input.runId,
    healthStatus: "healthy",
  };
}

const DEFAULT_DDR_V2_STORE_CONTRACTS: DdrV2StoreContracts = {
  async ensureCanonicalIncidents(db, events, options) {
    const incidents = await ensureCanonicalIncidentsStore(
      db,
      events.map(toStoreCanonicalIncidentInput),
      {
        runAt: options.runAt,
        runId: options.runId,
        predictionPolicyVersion: options.predictionPolicyVersion,
        policyDelaySec: options.policyDelaySec,
        policyEffectiveAt: options.policyEffectiveAt,
        createdBy: "ddr-worker",
      },
    );
    return incidents.map(mapStoreIncident);
  },
  async loadCanonicalIncidents(db, filters) {
    const incidents = await loadCanonicalIncidentsStore(db, {
      incidentKeys: filters.incidentKeys,
      eventIds: filters.eventIds,
      predictionPolicyVersion: filters.predictionPolicyVersion,
      policyUniverseIncluded: filters.policyUniverseIncluded,
      includeSuperseded: filters.includeSuperseded,
    });
    return incidents.map(mapStoreIncident);
  },
  async recordLockDeferral(db, input) {
    if (input.action !== "deferred") {
      await recordLockOpportunityStore(db, {
        incidentKey: input.incidentKey,
        eventId: input.eventId,
        predictionPolicyVersion: input.predictionPolicyVersion,
        eligibleAt: input.eligibleAt,
        runAt: input.runAt,
        createdAt: input.runAt,
        runId: input.runId,
        reason: input.reason,
        healthStatus: input.healthStatus,
        action: input.action,
        confirmationAt: input.confirmationAt,
        outcomeAt: input.outcomeAt,
      });
      return;
    }
    await recordLockDeferralStore(db, {
      incidentKey: input.incidentKey,
      eventId: input.eventId,
      predictionPolicyVersion: input.predictionPolicyVersion,
      eligibleAt: input.eligibleAt,
      runAt: input.runAt,
      createdAt: input.runAt,
      runId: input.runId,
      reason: input.reason,
      healthStatus: input.healthStatus,
      action: input.action,
    });
  },
  async sealPublicPrediction(db, input) {
    const result = await sealPublicPredictionStore(db, toStoreSealInput(input));
    return mapStoreSealedPublicPrediction(result);
  },
  async sealPublicNoCall(db, input) {
    const result = await sealPublicNoCallStore(db, {
      ...toStoreSealInput(input),
      resolutionTier: "insufficient_signal",
    });
    return mapStoreSealedPublicPrediction(result);
  },
  async loadSealedPublicPredictions(db, filters) {
    const rows = await loadSealedPublicPredictionsStore(db, {
      publicPredictionIds: filters.publicPredictionIds,
      incidentKeys: filters.incidentKeys,
      eventIds: filters.eventIds,
    });
    return rows.map(mapStoreSealedPublicPrediction);
  },
  async loadFirstPublicationMembership(db, filters) {
    const rows = await loadFirstPublicationMembershipStore(db, {
      publicPredictionIds: filters.publicPredictionIds,
      incidentKeys: filters.incidentKeys,
    });
    return rows.map(mapStoreFirstPublication);
  },
  async writePublicationManifest(db, input) {
    const manifest = await writePublicationManifestStore(db, {
      snapshotToken: input.snapshotToken,
      publishedAt: input.publishedAt,
      createdAt: input.publishedAt,
      snapshotGeneration: input.snapshotGeneration,
      validatorVersion: "ddr-worker-v2",
      basePayload: input.basePayload,
      publicPredictionIds: input.publicPredictionIds,
      publicPredictionRowHashes: input.publicPredictionRowHashes,
    });
    return mapStorePublicationManifest(manifest);
  },
  async loadLatestPublicationManifest(db) {
    const manifest = await loadLatestPublicationManifestStore(db);
    return manifest ? mapStorePublicationManifest(manifest) : null;
  },
  async loadPredictionErrata(db, filters) {
    const rows = await loadPredictionErrataStore(db, {
      incidentKeys: filters.incidentKeys,
      publicPredictionIds: filters.publicPredictionIds,
    });
    return rows as unknown as Array<Record<string, unknown>>;
  },
};

function normalizeComputeOptions(
  input: D1Database | ComputeDepegResolverV2Options,
  signal?: AbortSignal,
): Required<Pick<ComputeDepegResolverV2Options, "db" | "ddrRunId" | "runAt" | "slot" | "stablecoinsCacheSafe" | "depegPipelineHealthy" | "syncCapabilities">> &
  Pick<ComputeDepegResolverV2Options, "signal" | "storeContracts"> {
  const hasDb = typeof input === "object" && input != null && "db" in input;
  const nowSec = Math.floor(Date.now() / 1000);
  const options = hasDb ? input as ComputeDepegResolverV2Options : { db: input, signal };
  const runAt = options.runAt ?? nowSec;
  const slot = options.slot ?? "quarter-hour";
  return {
    db: options.db,
    signal: options.signal ?? signal,
    ddrRunId: options.ddrRunId ?? allocateDdrRunId(slot, runAt),
    runAt,
    slot,
    stablecoinsCacheSafe: options.stablecoinsCacheSafe ?? true,
    depegPipelineHealthy: options.depegPipelineHealthy ?? true,
    syncCapabilities: options.syncCapabilities ?? {},
    storeContracts: options.storeContracts === undefined ? DEFAULT_DDR_V2_STORE_CONTRACTS : options.storeContracts,
  };
}

function toDirection(value: string): DdrDirection {
  return value === "above" ? "above" : "below";
}

function eligibleAt(startedAt: number): number {
  return startedAt + DDR_PUBLIC_PREDICTION_DELAY_SEC;
}

function eventPolicyIncluded(row: DdrEventDbRow): boolean {
  return row.started_at >= DDR_V2_EFFECTIVE_AT || (row.started_at < DDR_V2_EFFECTIVE_AT && (row.ended_at == null || row.ended_at >= DDR_V2_EFFECTIVE_AT));
}

function buildRegistrySnapshot(meta: StablecoinMeta | undefined): Record<string, unknown> {
  if (!meta) return { publicTracked: false };
  return {
    publicTracked: true,
    id: meta.id,
    symbol: meta.symbol,
    status: meta.status ?? null,
    pegCurrency: meta.flags.pegCurrency,
    governance: meta.flags.governance,
    navToken: meta.flags.navToken === true,
  };
}

function toCanonicalIncidentInput(row: DdrEventDbRow): DdrCanonicalIncidentInput {
  const meta = TRACKED_META_BY_ID.get(row.stablecoin_id);
  return {
    eventId: row.id,
    stablecoinId: row.stablecoin_id,
    symbol: row.symbol,
    pegCurrency: pegCurrencyFromPegType(row.peg_type),
    direction: toDirection(row.direction),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    recoveryPrice: row.recovery_price,
    peakDeviationBps: row.peak_deviation_bps,
    source: row.source,
    sourceFingerprint: null,
    rolloutActiveAtEnablement: row.started_at < DDR_V2_EFFECTIVE_AT && (row.ended_at == null || row.ended_at >= DDR_V2_EFFECTIVE_AT),
    publicTrackedAtFirstSeen: meta != null,
    psiShadowAtFirstSeen: meta == null,
    predictionPolicyVersion: DDR_PREDICTION_POLICY_VERSION,
    policyDelaySec: DDR_PUBLIC_PREDICTION_DELAY_SEC,
    policyEffectiveAt: DDR_V2_EFFECTIVE_AT,
    registrySnapshot: buildRegistrySnapshot(meta),
  };
}

function fallbackIncidentForEvent(row: DdrEventDbRow): DdrCanonicalIncident {
  return {
    incidentKey: `unresolved:${row.id}`,
    eventId: row.id,
    currentEventId: row.id,
    stablecoinId: row.stablecoin_id,
    pegCurrency: pegCurrencyFromPegType(row.peg_type),
    direction: toDirection(row.direction),
    startedAt: row.started_at,
    eligibleAt: eligibleAt(row.started_at),
    policyUniverseIncluded: eventPolicyIncluded(row),
    rolloutActiveAtEnablement: row.started_at < DDR_V2_EFFECTIVE_AT,
    confirmedAt: null,
    lockState: null,
  };
}

function incidentKeyOfSealed(row: DdrSealedPublicPrediction): number {
  return publicPredictionIdOf(row);
}

function sealedByIncident(rows: readonly DdrSealedPublicPrediction[]): Map<string, DdrSealedPublicPrediction> {
  const out = new Map<string, DdrSealedPublicPrediction>();
  for (const row of rows) out.set(row.incidentKey, row);
  return out;
}

function firstPublicationByPredictionId(
  rows: readonly DdrFirstPublicationMembership[],
): Map<number, DdrFirstPublicationMembership> {
  const out = new Map<number, DdrFirstPublicationMembership>();
  for (const row of rows) {
    if (row.firstPublished) out.set(row.publicPredictionId, row);
  }
  return out;
}

function computeLockTiming(incident: DdrCanonicalIncident, lockedAt: number): DdrLockTiming {
  const lockState = incident.lockState;
  if (lockState && lockState.deferralCount > 0) return "deferred";
  if (incident.confirmedAt != null && incident.confirmedAt > incident.eligibleAt) return "late_confirmation";
  if (incident.rolloutActiveAtEnablement === true || incident.startedAt < DDR_V2_EFFECTIVE_AT) return "late_freeze";
  if (lockedAt <= incident.eligibleAt + DDR_LOCK_ON_TIME_GRACE_SEC) return "on_time";
  return "late_freeze";
}

function pendingPromotionKey(input: {
  stablecoin_id: string;
  peg_type: string;
  direction: string;
  started_at: number;
}): string {
  return `${input.stablecoin_id}\u0000${input.peg_type}\u0000${input.direction}\u0000${input.started_at}`;
}

function maybePendingPromotedEvent(row: DdrEventDbRow): boolean {
  return row.pending_reason != null || row.confirmation_sources != null;
}

async function loadPendingPromotionConfirmationTimes(
  db: D1Database,
  events: DdrEventDbRow[],
): Promise<{ byEventId: Map<number, number>; error: string | null }> {
  const candidates = events.filter(maybePendingPromotedEvent);
  if (candidates.length === 0) return { byEventId: new Map(), error: null };

  const stablecoinIds = [...new Set(candidates.map((row) => row.stablecoin_id))];
  const firstSeenAtValues = [...new Set(candidates.map((row) => row.started_at))];
  const result = await queryRows("depeg_pending_outcomes", () => db
    .prepare(
      `SELECT stablecoin_id, peg_type, direction, first_seen_at, outcome_at
       FROM depeg_pending_outcomes
       WHERE outcome = 'promoted'
         AND stablecoin_id IN (${placeholders(stablecoinIds.length)})
         AND first_seen_at IN (${placeholders(firstSeenAtValues.length)})`,
    )
    .bind(...stablecoinIds, ...firstSeenAtValues)
    .all<DdrPendingPromotionOutcomeRow>());
  if (result.error) return { byEventId: new Map(), error: result.error };

  const outcomeByKey = new Map<string, number>();
  for (const row of result.rows) {
    const key = pendingPromotionKey({
      stablecoin_id: row.stablecoin_id,
      peg_type: row.peg_type,
      direction: row.direction,
      started_at: row.first_seen_at,
    });
    const current = outcomeByKey.get(key);
    if (current == null || row.outcome_at > current) outcomeByKey.set(key, row.outcome_at);
  }

  const byEventId = new Map<number, number>();
  for (const event of candidates) {
    const confirmationAt = outcomeByKey.get(pendingPromotionKey({
      stablecoin_id: event.stablecoin_id,
      peg_type: event.peg_type,
      direction: event.direction,
      started_at: event.started_at,
    }));
    if (confirmationAt != null) byEventId.set(event.id, confirmationAt);
  }
  return { byEventId, error: null };
}

function applyConfirmationTimes(
  incidentsByEventId: Map<number, DdrCanonicalIncident>,
  confirmedAtByEventId: Map<number, number>,
): void {
  for (const [eventId, confirmedAt] of confirmedAtByEventId) {
    const incident = incidentsByEventId.get(eventId);
    if (!incident) continue;
    incidentsByEventId.set(eventId, { ...incident, confirmedAt });
    incidentsByEventId.set(incident.currentEventId, { ...incident, confirmedAt });
  }
}

async function recordConfirmedSeenOpportunities(input: {
  stores: DdrV2StoreContracts | null | undefined;
  db: D1Database;
  activeRows: DdrEventDbRow[];
  incidentsByEventId: Map<number, DdrCanonicalIncident>;
  confirmedAtByEventId: Map<number, number>;
  ddrRunId: string;
  runAt: number;
  syncCapabilities: Record<string, unknown>;
}): Promise<number> {
  if (!input.stores || input.confirmedAtByEventId.size === 0) return 0;

  let count = 0;
  for (const row of input.activeRows) {
    const confirmedAt = input.confirmedAtByEventId.get(row.id);
    if (confirmedAt == null) continue;
    const incident = input.incidentsByEventId.get(row.id) ?? fallbackIncidentForEvent(row);
    if (!incident.policyUniverseIncluded) continue;
    if (confirmedAt <= incident.eligibleAt) continue;
    if (incident.lockState?.lastState && incident.lockState.lastState !== "pending_lock" && incident.lockState.lastState !== "lock_deferred") {
      continue;
    }
    await input.stores.recordLockDeferral(input.db, {
      incidentKey: incident.incidentKey,
      eventId: row.id,
      runId: input.ddrRunId,
      runAt: input.runAt,
      eligibleAt: incident.eligibleAt,
      predictionPolicyVersion: DDR_PREDICTION_POLICY_VERSION,
      healthStatus: "healthy",
      action: "confirmed_seen",
      reason: "pending-outcome-promoted",
      confirmationAt: confirmedAt,
      outcomeAt: confirmedAt,
      syncCapabilities: input.syncCapabilities,
    });
    count += 1;
  }
  return count;
}

function buildFrozenDuration(row: DdrRow, lockedAt: number): Record<string, unknown> {
  const medianSec = row.duration.medianSec ?? null;
  const iqrSec = row.duration.iqrSec ?? null;
  return {
    ...row.duration,
    remainingAsOf: lockedAt,
    medianResolveAt: medianSec == null ? null : lockedAt + Math.round(medianSec),
    iqrResolveAt: iqrSec == null ? null : [lockedAt + Math.round(iqrSec[0]), lockedAt + Math.round(iqrSec[1])],
    horizons: row.duration.horizons.map((cell) => ({
      ...cell,
      horizonEndAt: lockedAt + ({ "6h": 6 * 3600, "24h": 24 * 3600, "7d": 7 * DAY, "30d": 30 * DAY } as const)[cell.horizon],
      anchoredLabel: `within ${cell.horizon} of lock`,
    })),
  };
}

function buildSealPayload(
  row: DdrRow,
  incident: DdrCanonicalIncident,
  lockedAt: number,
  lockTiming: DdrLockTiming,
): Record<string, unknown> {
  const base = {
    eventId: row.eventId,
    incidentKey: incident.incidentKey,
    stablecoinId: row.stablecoinId,
    symbol: row.symbol,
    name: row.name,
    pegCurrency: row.pegCurrency,
    governance: row.governance,
    status: row.status,
    direction: row.direction,
    startedAt: row.startedAt,
    prediction: {
      incidentKey: incident.incidentKey,
      eligibleAt: incident.eligibleAt,
      lockedAt,
      eventAgeAtLockSec: lockedAt - row.startedAt,
      lockTiming,
      policyDelaySec: DDR_PUBLIC_PREDICTION_DELAY_SEC,
      predictionPolicyVersion: DDR_PREDICTION_POLICY_VERSION,
      predictionMethodologyVersion: DDR_METHODOLOGY_VERSION,
      predictionMethodologyVersionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      resolutionRubricVersion: DDR_RESOLUTION_RUBRIC_VERSION,
      durationModelVersion: DDR_DURATION_MODEL_VERSION,
      incidentGroupingVersion: DDR_INCIDENT_GROUPING_VERSION,
      supportRulesVersion: DDR_SUPPORT_RULES_VERSION,
    },
  };

  if (row.resolution.tier === "insufficient_signal") {
    return {
      ...base,
      kind: "no_call",
      noCall: {
        lockedAt,
        eventAgeAtLockSec: lockedAt - row.startedAt,
        missingReasons: row.resolution.insufficientReasons ?? [],
        relatedContext: row.relatedContext,
      },
      frozen: null,
    };
  }

  return {
    ...base,
    kind: "prediction",
    frozen: {
      resolution: row.resolution,
      duration: buildFrozenDuration(row, lockedAt),
      relatedContext: row.relatedContext,
      sourceRow: row,
    },
  };
}

function buildBasePublicRow(row: DdrRow, incident: DdrCanonicalIncident): Record<string, unknown> {
  return {
    stablecoinId: row.stablecoinId,
    symbol: row.symbol,
    name: row.name,
    pegCurrency: row.pegCurrency,
    governance: row.governance,
    status: row.status ?? null,
    eventId: row.eventId,
    incidentKey: incident.incidentKey,
    startedAt: row.startedAt,
    direction: row.direction,
  };
}

function buildLiveOverlay(row: DdrRow, nowSec: number): Record<string, unknown> {
  return {
    currentEventId: row.eventId,
    ageSec: row.ageSec,
    peakDeviationBps: row.peakDeviationBps,
    currentDeviationBps: row.currentDeviationBps ?? null,
    eventState: "active",
    updatedAt: nowSec,
    stale: false,
    degradedReason: null,
  };
}

const DDR_ERRATUM_REASONS = new Set<string>(DDR_ERRATUM_REASON_VALUES);

function normalizeErratumRecord(row: Record<string, unknown>): DdrPredictionErratum | null {
  const id = nullableNumberValue(row.id);
  const publicPredictionId = nullableNumberValue(row.publicPredictionId ?? row.public_prediction_id);
  const eventId = nullableNumberValue(row.eventId ?? row.event_id);
  const assessmentId = nullableNumberValue(row.assessmentId ?? row.assessment_id);
  const createdAt = nullableNumberValue(row.createdAt ?? row.created_at);
  const reason = row.reason;
  const incidentKey = row.incidentKey ?? row.incident_key;
  const operatorNote = row.operatorNote ?? row.operator_note;
  const createdBy = row.createdBy ?? row.created_by;
  if (
    id == null ||
    id <= 0 ||
    publicPredictionId == null ||
    publicPredictionId <= 0 ||
    eventId == null ||
    eventId <= 0 ||
    assessmentId == null ||
    assessmentId <= 0 ||
    createdAt == null ||
    createdAt <= 0 ||
    typeof reason !== "string" ||
    !DDR_ERRATUM_REASONS.has(reason) ||
    typeof incidentKey !== "string" ||
    typeof operatorNote !== "string" ||
    typeof createdBy !== "string"
  ) {
    return null;
  }

  return {
    id,
    state: "invalidated",
    publicPredictionId,
    incidentKey,
    eventId,
    assessmentId,
    reason: reason as DdrPredictionErratum["reason"],
    createdAt,
    operatorNote,
    rowHashBefore: nullableStringValue(row.rowHashBefore ?? row.row_hash_before, null),
    replacementAssessmentId: nullableNumberValue(row.replacementAssessmentId ?? row.replacement_assessment_id),
    replacementRowHash: nullableStringValue(row.replacementRowHash ?? row.replacement_row_hash, null),
    createdBy,
  };
}

function sortErrata(rows: DdrPredictionErratum[]): DdrPredictionErratum[] {
  return [...rows].sort((left, right) => right.createdAt - left.createdAt || right.id - left.id);
}

function groupErrata(input: readonly DdrPredictionErratum[]): {
  byPublicPredictionId: Map<number, DdrPredictionErratum[]>;
  byIncidentKey: Map<string, DdrPredictionErratum[]>;
} {
  const byPublicPredictionId = new Map<number, DdrPredictionErratum[]>();
  const byIncidentKey = new Map<string, DdrPredictionErratum[]>();
  for (const erratum of input) {
    byPublicPredictionId.set(erratum.publicPredictionId, sortErrata([...(byPublicPredictionId.get(erratum.publicPredictionId) ?? []), erratum]));
    byIncidentKey.set(erratum.incidentKey, sortErrata([...(byIncidentKey.get(erratum.incidentKey) ?? []), erratum]));
  }
  return { byPublicPredictionId, byIncidentKey };
}

function errataForSealed(input: {
  sealed: DdrSealedPublicPrediction;
  byPublicPredictionId: Map<number, DdrPredictionErratum[]>;
  byIncidentKey: Map<string, DdrPredictionErratum[]>;
}): DdrPredictionErratum[] {
  const publicPredictionId = publicPredictionIdOf(input.sealed);
  const byId = input.byPublicPredictionId.get(publicPredictionId) ?? [];
  const byIncident = input.byIncidentKey.get(input.sealed.incidentKey) ?? [];
  const byErratumId = new Map<number, DdrPredictionErratum>();
  for (const erratum of [...byId, ...byIncident]) byErratumId.set(erratum.id, erratum);
  return sortErrata([...byErratumId.values()]);
}

async function loadErrataForSealedPredictions(input: {
  stores: DdrV2StoreContracts | null | undefined;
  db: D1Database;
  sealed: DdrSealedPublicPrediction[];
}): Promise<{ errata: DdrPredictionErratum[]; error: string | null }> {
  if (!input.stores?.loadPredictionErrata || input.sealed.length === 0) return { errata: [], error: null };
  try {
    const rows = await input.stores.loadPredictionErrata(input.db, {
      publicPredictionIds: input.sealed.map(publicPredictionIdOf),
      incidentKeys: input.sealed.map((sealed) => sealed.incidentKey),
    });
    return {
      errata: sortErrata(rows.map(normalizeErratumRecord).filter((row): row is DdrPredictionErratum => row != null)),
      error: null,
    };
  } catch (error) {
    return { errata: [], error: formatDdrrFailure(error) };
  }
}

function buildBasePublicRowFromSealed(
  sealed: DdrSealedPublicPrediction,
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  const payload = sealed.sealedPayload;
  const fallbackDirection = fallback.direction === "above" || fallback.direction === "below" ? fallback.direction : "below";
  return {
    stablecoinId: stringValue(payload.stablecoinId, stringValue(fallback.stablecoinId, "")),
    symbol: stringValue(payload.symbol, stringValue(fallback.symbol, "")),
    name: stringValue(payload.name, stringValue(fallback.name, "")),
    pegCurrency: stringValue(payload.pegCurrency, stringValue(fallback.pegCurrency, "USD")),
    governance: stringValue(payload.governance, stringValue(fallback.governance, "unknown")),
    status: nullableStringValue(payload.status, nullableStringValue(fallback.status, null)),
    eventId: numberValue(payload.eventId, sealed.eventId),
    incidentKey: sealed.incidentKey,
    startedAt: numberValue(payload.startedAt, numberValue(fallback.startedAt, 0)),
    direction: payload.direction === "above" || payload.direction === "below" ? payload.direction : fallbackDirection,
  };
}

function buildPredictionMeta(input: {
  state: "pending_lock" | "lock_deferred" | "publication_retry_pending" | "frozen" | "no_call" | "invalidated";
  incident: DdrCanonicalIncident;
  publicPredictionId: number | null;
  sealed: DdrSealedPublicPrediction | null;
  publication: DdrFirstPublicationMembership | null;
  deferralReason: string | null;
  modelAsOf: number;
  errataHistory?: DdrPredictionErratum[];
}): Record<string, unknown> {
  const errataHistory = input.errataHistory ?? [];
  const policyDelaySec = input.sealed?.policyDelaySec ?? Math.max(0, input.incident.eligibleAt - input.incident.startedAt);
  return {
    state: input.state,
    publicPredictionId: input.publicPredictionId,
    incidentKey: input.incident.incidentKey,
    predictionPolicyVersion: DDR_PREDICTION_POLICY_VERSION,
    predictionMethodologyVersion: input.sealed?.predictionMethodologyVersion ?? null,
    predictionMethodologyVersionLabel: input.sealed ? DDR_METHODOLOGY_VERSION_LABEL : null,
    resolutionRubricVersion: input.sealed ? DDR_RESOLUTION_RUBRIC_VERSION : null,
    durationModelVersion: input.sealed ? DDR_DURATION_MODEL_VERSION : null,
    incidentGroupingVersion: input.sealed ? DDR_INCIDENT_GROUPING_VERSION : null,
    supportRulesVersion: input.sealed ? DDR_SUPPORT_RULES_VERSION : null,
    eligibleAt: input.incident.eligibleAt,
    policyDelaySec,
    lockedAt: input.sealed?.lockedAt ?? null,
    publishedAt: input.publication?.publishedAt ?? null,
    publicationSnapshotToken: input.publication?.snapshotToken ?? null,
    snapshotGeneration: input.publication?.snapshotGeneration ?? null,
    eventAgeAtLockSec: input.sealed?.eventAgeAtLockSec ?? null,
    lockTiming: input.sealed?.lockTiming ?? null,
    source: input.state === "invalidated" ? "erratum" : input.sealed ? "public_prediction" : "pending",
    deferralReason: input.deferralReason,
    deferralCount: input.incident.lockState?.deferralCount ?? null,
    rowHash: input.sealed?.rowHash ?? null,
    lineage: null,
    modelAsOf: input.modelAsOf,
    latestErratum: errataHistory[0] ?? null,
    errataCount: errataHistory.length,
    errataHistory,
  };
}

function publicationBySealedId(input: {
  firstPublication: DdrFirstPublicationMembership[];
  manifest: DdrPublicationManifest | null;
  sealed: DdrSealedPublicPrediction[];
}): Map<number, DdrFirstPublicationMembership> {
  const out = firstPublicationByPredictionId(input.firstPublication);
  if (input.manifest) {
    const manifestIds = new Set(input.manifest.publicPredictionIds);
    for (const sealed of input.sealed) {
      const publicPredictionId = incidentKeyOfSealed(sealed);
      if (!manifestIds.has(publicPredictionId) || out.has(publicPredictionId)) continue;
      out.set(publicPredictionId, {
        publicPredictionId,
        incidentKey: sealed.incidentKey,
        snapshotToken: input.manifest.snapshotToken,
        snapshotGeneration: input.manifest.snapshotGeneration,
        publishedAt: input.manifest.publishedAt,
        firstPublished: input.manifest.firstPublishedPublicPredictionIds.includes(publicPredictionId),
      });
    }
  }
  return out;
}

function buildPublicRows(input: {
  candidateRows: DdrRow[];
  incidentsByEventId: Map<number, DdrCanonicalIncident>;
  sealed: DdrSealedPublicPrediction[];
  firstPublication: DdrFirstPublicationMembership[];
  manifest: DdrPublicationManifest | null;
  errata: DdrPredictionErratum[];
  nowSec: number;
  storageAvailable: boolean;
}): DdrResponse["rows"] {
  const sealedByKey = sealedByIncident(input.sealed);
  const errata = groupErrata(input.errata);
  const publicationById = publicationBySealedId({
    firstPublication: input.firstPublication,
    manifest: input.manifest,
    sealed: input.sealed,
  });

  return input.candidateRows.map((row) => {
    const incident = input.incidentsByEventId.get(row.eventId) ?? {
      incidentKey: `unresolved:${row.eventId}`,
      eventId: row.eventId,
      currentEventId: row.eventId,
      stablecoinId: row.stablecoinId,
      pegCurrency: row.pegCurrency,
      direction: row.direction,
      startedAt: row.startedAt,
      eligibleAt: eligibleAt(row.startedAt),
      policyUniverseIncluded: false,
      lockState: null,
    };
    const sealed = sealedByKey.get(incident.incidentKey) ?? null;
    const publicPredictionId = sealed ? incidentKeyOfSealed(sealed) : null;
    const publication = publicPredictionId == null ? null : publicationById.get(publicPredictionId) ?? null;
    const base = buildBasePublicRow(row, incident);
    const live = buildLiveOverlay(row, input.nowSec);

    if (!sealed) {
      const lockEligible = input.nowSec >= incident.eligibleAt;
      return {
        ...base,
        kind: "pending",
        prediction: buildPredictionMeta({
          state: lockEligible ? "lock_deferred" : "pending_lock",
          incident,
          publicPredictionId: null,
          sealed: null,
          publication: null,
          deferralReason: lockEligible && !input.storageAvailable ? "storage-contract-unavailable" : incident.lockState?.lastDeferralReason ?? null,
          modelAsOf: input.nowSec,
        }),
        frozen: null,
        live,
      };
    }

    if (!publication) {
      return {
        ...base,
        kind: "pending",
        prediction: buildPredictionMeta({
          state: "publication_retry_pending",
          incident,
          publicPredictionId,
          sealed,
          publication: null,
          deferralReason: "publication-retry-pending",
          modelAsOf: sealed.lockedAt,
        }),
        frozen: null,
        live,
      };
    }

    const errataHistory = errataForSealed({
      sealed,
      byPublicPredictionId: errata.byPublicPredictionId,
      byIncidentKey: errata.byIncidentKey,
    });

    if (sealed.outcomeKind === "no_call") {
      const sealedNoCall = recordValue(sealed.sealedPayload.noCall);
      const noCall = sealedNoCall ?? {
        lockedAt: sealed.lockedAt,
        eventAgeAtLockSec: sealed.eventAgeAtLockSec,
        missingReasons: row.resolution.insufficientReasons ?? [],
        relatedContext: row.relatedContext,
      };
      if (errataHistory.length > 0) {
        return {
          ...buildBasePublicRowFromSealed(sealed, base),
          kind: "invalidated_prediction",
          prediction: buildPredictionMeta({
            state: "invalidated",
            incident,
            publicPredictionId,
            sealed,
            publication,
            deferralReason: null,
            modelAsOf: sealed.lockedAt,
            errataHistory,
          }),
          originalKind: "no_call",
          originalOutcome: noCall,
          noCall,
          frozen: null,
          live,
        };
      }
      return {
        ...base,
        kind: "no_call",
        prediction: buildPredictionMeta({
          state: "no_call",
          incident,
          publicPredictionId,
          sealed,
          publication,
          deferralReason: null,
          modelAsOf: sealed.lockedAt,
        }),
        noCall,
        frozen: null,
        live,
      };
    }

    const sealedFrozen = recordValue(sealed.sealedPayload.frozen);
    const frozen = sealedFrozen ?? {
      resolution: row.resolution,
      duration: buildFrozenDuration(row, sealed.lockedAt),
      relatedContext: row.relatedContext,
      sourceRow: row,
    };
    if (errataHistory.length > 0) {
      return {
        ...buildBasePublicRowFromSealed(sealed, base),
        kind: "invalidated_prediction",
        prediction: buildPredictionMeta({
          state: "invalidated",
          incident,
          publicPredictionId,
          sealed,
          publication,
          deferralReason: null,
          modelAsOf: sealed.lockedAt,
          errataHistory,
        }),
        originalKind: "prediction",
        originalOutcome: frozen,
        frozen,
        noCall: null,
        live,
      };
    }
    return {
      ...base,
      kind: "prediction",
      prediction: buildPredictionMeta({
        state: "frozen",
        incident,
        publicPredictionId,
        sealed,
        publication,
        deferralReason: null,
        modelAsOf: sealed.lockedAt,
      }),
      frozen,
      live,
    };
  }) as DdrResponse["rows"];
}

function buildDdrResponse(input: {
  candidateRows: DdrRow[];
  incidentsByEventId: Map<number, DdrCanonicalIncident>;
  sealed: DdrSealedPublicPrediction[];
  firstPublication: DdrFirstPublicationMembership[];
  manifest: DdrPublicationManifest | null;
  errata: DdrPredictionErratum[];
  lineage: DdrResponse["_meta"]["lineage"];
  nowSec: number;
  storageAvailable: boolean;
}): DdrResponse {
  const publicPredictionRows = input.sealed
    .map((sealed) => [incidentKeyOfSealed(sealed), sealed.rowHash] as const)
    .sort(([a], [b]) => a - b);
  return {
    _meta: {
      schemaVersion: 2,
      dataAsOf: input.nowSec,
      modelAsOf: input.nowSec,
      computedAt: input.nowSec,
      expiresAt: input.nowSec + 1800,
      snapshotToken: input.manifest?.snapshotToken ?? null,
      snapshotGeneration: input.manifest?.snapshotGeneration ?? null,
      publicPredictionIds: publicPredictionRows.map(([id]) => id),
      publicPredictionRowHashes: Object.fromEntries(publicPredictionRows.map(([id, hash]) => [String(id), hash])),
      basePayloadHash: input.manifest?.basePayloadHash ?? null,
      readOverlay: {
        degradedLockDeferralIncidentKeys: [],
        closedPendingReviewIncidentKeys: [],
        suppressedIncidentKeys: [],
      },
      degraded: false,
      degradedReason: null,
      publicWarning: DDR_PUBLIC_WARNING,
      resolutionRubricVersion: DDR_RESOLUTION_RUBRIC_VERSION,
      durationModelVersion: DDR_DURATION_MODEL_VERSION,
      incidentGroupingVersion: DDR_INCIDENT_GROUPING_VERSION,
      supportRulesVersion: DDR_SUPPORT_RULES_VERSION,
      lineage: input.lineage,
    },
    rows: buildPublicRows(input),
    methodology: buildMethodologyEnvelope({
      version: DDR_METHODOLOGY_VERSION,
      versionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      currentVersion: DDR_METHODOLOGY_VERSION,
      currentVersionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      changelogPath: DDR_METHODOLOGY_CHANGELOG_PATH,
      asOf: input.nowSec,
    }),
  };
}

async function queryRows<T>(label: string, query: () => Promise<{ results?: T[] }>): Promise<QueryRowsResult<T>> {
  try {
    const result = await query();
    return { rows: result.results ?? [], error: null };
  } catch (error) {
    return {
      rows: [],
      error: `${label}:${formatDdrrFailure(error)}`,
    };
  }
}

/** Latest supply <= ts, walking a coin's ascending snapshots. */
function supplyAt(snapshots: { date: number; usd: number }[], ts: number): number | null {
  let val: number | null = null;
  for (const s of snapshots) {
    if (s.date <= ts) val = s.usd;
    else break;
  }
  return val;
}

function buildSupplyContext(snapshots: { date: number; usd: number }[], startedAt: number): DdrSupplyContext {
  if (snapshots.length < 2) {
    return { covered: false, change7dPct: null, change30dPct: null, mintSurge: null };
  }
  const onset = supplyAt(snapshots, startedAt) ?? snapshots[snapshots.length - 1].usd;
  const d7 = supplyAt(snapshots, startedAt - 7 * DAY);
  const d30 = supplyAt(snapshots, startedAt - 30 * DAY);
  const change7dPct = d7 != null && d7 > 0 ? ((onset - d7) / d7) * 100 : null;
  const change30dPct = d30 != null && d30 > 0 ? ((onset - d30) / d30) * 100 : null;
  return {
    covered: true,
    change7dPct,
    change30dPct,
    mintSurge: change7dPct != null ? change7dPct > 20 : null,
  };
}

async function buildCurrentDeviationMap(
  db: D1Database,
  nowSec: number,
): Promise<CurrentDeviationMapResult> {
  const cache = await loadStablecoinsCache(db, { mode: "lenient", contract: "critical-fields" });
  if (!hasUsableStablecoinsPayload(cache) || cache.updatedAt == null || nowSec - cache.updatedAt > CURRENT_PRICE_MAX_AGE_SEC) {
    const reason = !hasUsableStablecoinsPayload(cache)
      ? `stablecoins-cache-${cache.kind === "error" || cache.kind === "degraded" ? cache.reason : "unusable"}`
      : "stablecoins-cache-stale";
    return { byCoin: new Map(), healthy: false, degradedReason: reason, dataAsOf: cache.updatedAt ?? null };
  }

  const assets = cache.payload.peggedAssets as StablecoinData[];
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const { rates } = derivePegRates(assets, TRACKED_META_BY_ID, cache.payload.fxFallbackRates);
  const out = new Map<string, number | null>();

  for (const [id, asset] of assetById) {
    const meta = TRACKED_META_BY_ID.get(id);
    if (!meta || meta.flags.navToken) continue;
    const supply = asset.circulating ? sumPegBuckets(asset.circulating) : 0;
    if (supply <= 0 || asset.price == null || !Number.isFinite(asset.price)) {
      out.set(id, null);
      continue;
    }
    const pegRef = getPegReference(asset.pegType, rates, meta.commodityOunces);
    out.set(id, deriveDepegSignal(asset.price, pegRef)?.bps ?? null);
  }

  return { byCoin: out, healthy: true, degradedReason: null, dataAsOf: cache.updatedAt };
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

function formatDdrrFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publicationSnapshotToken(runId: string, publishedAt: number): string {
  return `ddrpub:${publishedAt}:${runId.replace(/[^A-Za-z0-9_.:-]/g, "_")}`;
}

async function loadPolicyUniverseEvents(db: D1Database): Promise<DdrEventDbRow[]> {
  const result = await db
    .prepare(
      "SELECT id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, " +
        "recovery_price, peg_reference, source, confirmation_sources, pending_reason, " +
        "provenance_replay_run_id, provenance_replay_version " +
        "FROM depeg_events_with_provenance " +
        "WHERE (provenance_audit_verdict IS NULL OR provenance_audit_verdict NOT IN ('false_positive', 'disputed', 'no_data')) " +
        "AND (started_at >= ? OR (started_at < ? AND (ended_at IS NULL OR ended_at >= ?))) " +
        "ORDER BY started_at ASC, id ASC",
    )
    .bind(DDR_V2_EFFECTIVE_AT, DDR_V2_EFFECTIVE_AT, DDR_V2_EFFECTIVE_AT)
    .all<DdrEventDbRow>();
  return result.results ?? [];
}

async function loadActiveConfirmedEvents(db: D1Database): Promise<DdrEventDbRow[]> {
  const activeResult = await db
    .prepare(
      "SELECT id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, " +
        "recovery_price, peg_reference, source, confirmation_sources, pending_reason, " +
        "provenance_replay_run_id, provenance_replay_version " +
        "FROM depeg_events_with_provenance WHERE ended_at IS NULL " +
        "AND (provenance_audit_verdict IS NULL OR provenance_audit_verdict NOT IN ('false_positive', 'disputed', 'no_data')) " +
        "ORDER BY started_at ASC",
    )
    .all<DdrEventDbRow>();

  return (activeResult.results ?? []).filter((row) => {
    const status = TRACKED_META_BY_ID.get(row.stablecoin_id)?.status ?? null;
    return !isTerminalStablecoinStatus(status);
  });
}

async function ensureCanonicalIncidentsForEvents(
  stores: DdrV2StoreContracts | null | undefined,
  db: D1Database,
  events: DdrEventDbRow[],
  options: Required<Pick<ComputeDepegResolverV2Options, "ddrRunId" | "runAt">>,
): Promise<Map<number, DdrCanonicalIncident>> {
  if (!stores || events.length === 0) {
    return new Map(events.map((event) => [event.id, fallbackIncidentForEvent(event)]));
  }

  const incidents = await stores.ensureCanonicalIncidents(
    db,
    events.map(toCanonicalIncidentInput),
    {
      runId: options.ddrRunId,
      runAt: options.runAt,
      predictionPolicyVersion: DDR_PREDICTION_POLICY_VERSION,
      policyDelaySec: DDR_PUBLIC_PREDICTION_DELAY_SEC,
      policyEffectiveAt: DDR_V2_EFFECTIVE_AT,
    },
  );
  const byEventId = new Map<number, DdrCanonicalIncident>();
  for (const incident of incidents) {
    byEventId.set(incident.eventId, incident);
    byEventId.set(incident.currentEventId, incident);
  }
  for (const event of events) {
    if (!byEventId.has(event.id)) byEventId.set(event.id, fallbackIncidentForEvent(event));
  }
  return byEventId;
}

async function recordSystemHealthDeferrals(input: {
  stores: DdrV2StoreContracts | null | undefined;
  db: D1Database;
  incidentsByEventId: Map<number, DdrCanonicalIncident>;
  activeRows: DdrEventDbRow[];
  nowSec: number;
  ddrRunId: string;
  runAt: number;
  syncCapabilities: Record<string, unknown>;
  reason: string;
}): Promise<number> {
  if (!input.stores) return 0;
  let count = 0;
  for (const row of input.activeRows) {
    const incident = input.incidentsByEventId.get(row.id) ?? fallbackIncidentForEvent(row);
    if (!incident.policyUniverseIncluded || input.nowSec < incident.eligibleAt) continue;
    await input.stores.recordLockDeferral(input.db, {
      incidentKey: incident.incidentKey,
      eventId: row.id,
      runId: input.ddrRunId,
      runAt: input.runAt,
      eligibleAt: incident.eligibleAt,
      predictionPolicyVersion: DDR_PREDICTION_POLICY_VERSION,
      healthStatus: "degraded",
      action: "deferred",
      reason: input.reason,
      syncCapabilities: input.syncCapabilities,
    });
    count += 1;
  }
  return count;
}

async function loadSealedAndPublicationState(input: {
  stores: DdrV2StoreContracts | null | undefined;
  db: D1Database;
  incidentKeys: string[];
}): Promise<{
  sealed: DdrSealedPublicPrediction[];
  firstPublication: DdrFirstPublicationMembership[];
}> {
  if (!input.stores || input.incidentKeys.length === 0) {
    return { sealed: [], firstPublication: [] };
  }
  const sealed = await input.stores.loadSealedPublicPredictions(input.db, {
    incidentKeys: input.incidentKeys,
    predictionPolicyVersion: DDR_PREDICTION_POLICY_VERSION,
    includeUnpublished: true,
  });
  const firstPublication = await input.stores.loadFirstPublicationMembership(input.db, {
    incidentKeys: input.incidentKeys,
    predictionPolicyVersion: DDR_PREDICTION_POLICY_VERSION,
  });
  return { sealed, firstPublication };
}

async function sealEligibleLocks(input: {
  stores: DdrV2StoreContracts | null | undefined;
  db: D1Database;
  rows: DdrRow[];
  activeEventById: Map<number, DdrEventDbRow>;
  incidentsByEventId: Map<number, DdrCanonicalIncident>;
  existingSealed: DdrSealedPublicPrediction[];
  nowSec: number;
  ddrRunId: string;
  runAt: number;
  syncCapabilities: Record<string, unknown>;
}): Promise<{ sealed: DdrSealedPublicPrediction[]; lockedCount: number; noCallCount: number; pendingCount: number }> {
  if (!input.stores) return { sealed: input.existingSealed, lockedCount: 0, noCallCount: 0, pendingCount: 0 };

  const sealed = [...input.existingSealed];
  const sealedByKey = sealedByIncident(sealed);
  let lockedCount = 0;
  let noCallCount = 0;
  let pendingCount = 0;

  for (const row of input.rows) {
    const sourceEvent = input.activeEventById.get(row.eventId);
    if (!sourceEvent) continue;
    const incident = input.incidentsByEventId.get(row.eventId) ?? fallbackIncidentForEvent(sourceEvent);
    if (!incident.policyUniverseIncluded) continue;

    if (input.nowSec < incident.eligibleAt) {
      await input.stores.recordLockDeferral(input.db, {
        incidentKey: incident.incidentKey,
        eventId: row.eventId,
        runId: input.ddrRunId,
        runAt: input.runAt,
        eligibleAt: incident.eligibleAt,
        predictionPolicyVersion: DDR_PREDICTION_POLICY_VERSION,
        healthStatus: "healthy",
        action: "pending",
        reason: null,
        syncCapabilities: input.syncCapabilities,
      });
      pendingCount += 1;
      continue;
    }

    if (sealedByKey.has(incident.incidentKey)) continue;

    const lockTiming = computeLockTiming(incident, input.nowSec);
    const sealedPayload = buildSealPayload(row, incident, input.nowSec, lockTiming);
    const sealInput: DdrSealInput = {
      incidentKey: incident.incidentKey,
      eventId: row.eventId,
      runId: input.ddrRunId,
      lockedAt: input.nowSec,
      eligibleAt: incident.eligibleAt,
      eventAgeAtLockSec: input.nowSec - row.startedAt,
      lockTiming,
      predictionPolicyVersion: DDR_PREDICTION_POLICY_VERSION,
      policyDelaySec: DDR_PUBLIC_PREDICTION_DELAY_SEC,
      methodologyVersion: DDR_METHODOLOGY_VERSION,
      methodologyVersionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      resolutionRubricVersion: DDR_RESOLUTION_RUBRIC_VERSION,
      durationModelVersion: DDR_DURATION_MODEL_VERSION,
      incidentGroupingVersion: DDR_INCIDENT_GROUPING_VERSION,
      supportRulesVersion: DDR_SUPPORT_RULES_VERSION,
      row,
      sealedPayload,
    };
    const created = row.resolution.tier === "insufficient_signal"
      ? await input.stores.sealPublicNoCall(input.db, sealInput)
      : await input.stores.sealPublicPrediction(input.db, sealInput);
    sealed.push(created);
    sealedByKey.set(created.incidentKey, created);
    if (created.outcomeKind === "no_call") noCallCount += 1;
    else lockedCount += 1;
  }

  return { sealed, lockedCount, noCallCount, pendingCount };
}

function buildV2PublicationBasePayload(input: {
  snapshot: DdrDiagnosticResponse;
  incidentsByEventId: Map<number, DdrCanonicalIncident>;
  sealed: DdrSealedPublicPrediction[];
  firstPublication: DdrFirstPublicationMembership[];
  errata: DdrPredictionErratum[];
  snapshotToken: string;
  nowSec: number;
}): Record<string, unknown> {
  const publicPredictionRows = input.sealed
    .map((sealed) => [incidentKeyOfSealed(sealed), sealed.rowHash] as const)
    .sort(([a], [b]) => a - b);
  const response: DdrResponse = {
    _meta: {
      schemaVersion: 2,
      dataAsOf: input.snapshot._meta.dataAsOf,
      modelAsOf: input.snapshot._meta.modelAsOf,
      computedAt: input.snapshot._meta.computedAt,
      expiresAt: input.snapshot._meta.expiresAt,
      snapshotToken: input.snapshotToken,
      snapshotGeneration: DDR_SNAPSHOT_CACHE_GENERATION,
      publicPredictionIds: publicPredictionRows.map(([id]) => id),
      publicPredictionRowHashes: Object.fromEntries(publicPredictionRows.map(([id, hash]) => [String(id), hash])),
      basePayloadHash: null,
      readOverlay: {
        degradedLockDeferralIncidentKeys: [],
        closedPendingReviewIncidentKeys: [],
        suppressedIncidentKeys: [],
      },
      degraded: false,
      degradedReason: null,
      publicWarning: DDR_PUBLIC_WARNING,
      resolutionRubricVersion: DDR_RESOLUTION_RUBRIC_VERSION,
      durationModelVersion: DDR_DURATION_MODEL_VERSION,
      incidentGroupingVersion: DDR_INCIDENT_GROUPING_VERSION,
      supportRulesVersion: DDR_SUPPORT_RULES_VERSION,
      lineage: input.snapshot._meta.lineage,
    },
    rows: buildPublicRows({
      candidateRows: input.snapshot.rows,
      incidentsByEventId: input.incidentsByEventId,
      sealed: input.sealed,
      firstPublication: input.firstPublication,
      manifest: null,
      errata: input.errata,
      nowSec: input.nowSec,
      storageAvailable: true,
    }),
    methodology: input.snapshot.methodology,
  };
  return buildDdrManifestBasePayload(response) as Record<string, unknown>;
}

async function writePublicationBeforeCache(input: {
  stores: DdrV2StoreContracts | null | undefined;
  db: D1Database;
  snapshot: DdrDiagnosticResponse;
  incidentsByEventId: Map<number, DdrCanonicalIncident>;
  sealed: DdrSealedPublicPrediction[];
  firstPublication: DdrFirstPublicationMembership[];
  errata: DdrPredictionErratum[];
  ddrRunId: string;
  nowSec: number;
}): Promise<{
  attempted: boolean;
  ok: boolean;
  manifest: DdrPublicationManifest | null;
  firstPublication: DdrFirstPublicationMembership[];
  error: string | null;
}> {
  if (!input.stores) {
    return { attempted: false, ok: true, manifest: null, firstPublication: input.firstPublication, error: null };
  }
  const activeIncidentKeys = [...new Set([...input.incidentsByEventId.values()].map((incident) => incident.incidentKey))];
  const snapshotToken = publicationSnapshotToken(input.ddrRunId, input.nowSec);
  const existingFirstPublication = firstPublicationByPredictionId(input.firstPublication);
  const firstPublication = [
    ...input.firstPublication,
    ...input.sealed
      .filter((sealed) => !existingFirstPublication.has(incidentKeyOfSealed(sealed)))
      .map((sealed): DdrFirstPublicationMembership => ({
        publicPredictionId: incidentKeyOfSealed(sealed),
        incidentKey: sealed.incidentKey,
        snapshotToken,
        snapshotGeneration: DDR_SNAPSHOT_CACHE_GENERATION,
        publishedAt: input.nowSec,
        firstPublished: true,
      })),
  ];
  const basePayload = buildV2PublicationBasePayload({
    snapshot: input.snapshot,
    incidentsByEventId: input.incidentsByEventId,
    sealed: input.sealed,
    firstPublication,
    errata: input.errata,
    snapshotToken,
    nowSec: input.nowSec,
  });
  const publicPredictionIds = input.sealed.map(incidentKeyOfSealed).sort((a, b) => a - b);
  const publicPredictionRowHashes = Object.fromEntries(
    input.sealed.map((sealed) => [String(incidentKeyOfSealed(sealed)), sealed.rowHash]).sort(([a], [b]) => a.localeCompare(b)),
  );
  try {
    const manifest = await input.stores.writePublicationManifest(input.db, {
      runId: input.ddrRunId,
      snapshotToken,
      publishedAt: input.nowSec,
      snapshotKind: DDR_PUBLICATION_SNAPSHOT_KIND,
      snapshotGeneration: DDR_SNAPSHOT_CACHE_GENERATION,
      basePayload,
      activeIncidentKeys,
      publicPredictionIds,
      publicPredictionRowHashes,
    });
    return { attempted: true, ok: true, manifest, firstPublication, error: null };
  } catch (error) {
    for (const sealed of input.sealed) {
      await input.stores.recordLockDeferral(input.db, {
        incidentKey: sealed.incidentKey,
        eventId: sealed.eventId,
        runId: input.ddrRunId,
        runAt: input.nowSec,
        eligibleAt: sealed.eligibleAt,
        predictionPolicyVersion: DDR_PREDICTION_POLICY_VERSION,
        healthStatus: "healthy",
        action: "publication_retry_pending",
        reason: formatDdrrFailure(error),
        syncCapabilities: {},
      });
    }
    return { attempted: true, ok: false, manifest: null, firstPublication: input.firstPublication, error: formatDdrrFailure(error) };
  }
}

async function persistDepegResolverReviewArtifacts(
  db: D1Database,
  snapshot: DdrDiagnosticResponse,
  signal?: AbortSignal,
  storeContracts?: DdrV2StoreContracts | null,
): Promise<{ assessmentWriteCount: number; reviewRows: number; reviewError: string | null }> {
  let assessmentWriteCount = 0;
  let reviewRows = 0;

  try {
    assessmentWriteCount = await writeDepegResolverAssessments(db, snapshot as unknown as DdrResponse);
    const reviewResult = await computeAndStoreDepegResolverReview(db, signal, { storeContracts });
    reviewRows = reviewResult.itemCount ?? 0;
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      assessmentWriteCount,
      reviewRows,
      reviewError: formatDdrrFailure(error),
    };
  }

  return { assessmentWriteCount, reviewRows, reviewError: null };
}

export async function computeDepegResolver(
  input: D1Database | ComputeDepegResolverV2Options,
  signal?: AbortSignal,
): Promise<CronResult> {
  const options = normalizeComputeOptions(input, signal);
  const { db, storeContracts } = options;
  abortIf(options.signal, "compute-depeg-resolver");
  const nowSec = options.runAt;

  const currencyOf = (id: string): string => TRACKED_META_BY_ID.get(id)?.flags.pegCurrency ?? "USD";
  const classOf = (id: string) => {
    const meta = TRACKED_META_BY_ID.get(id);
    return meta ? structuralClass(toStructural(meta)) : ("fragile" as const);
  };

  const policyUniverseRows = await loadPolicyUniverseEvents(db);
  const activeRows = await loadActiveConfirmedEvents(db);
  const incidentRows = policyUniverseRows.length > 0 ? policyUniverseRows : activeRows;
  const incidentsByEventId = await ensureCanonicalIncidentsForEvents(storeContracts, db, incidentRows, {
    ddrRunId: options.ddrRunId,
    runAt: options.runAt,
  });

  let rows: DdrRow[] = [];
  let lineage: DdrResponse["_meta"]["lineage"] = {
    trainingWindow: { start: nowSec - TRAINING_WINDOW_SEC, end: nowSec },
    eventCount: 0,
    incidentCount: 0,
    coinCount: 0,
    quarantinedCoins: 0,
  };
  let assessmentWriteCount = 0;
  let reviewRows = 0;
  let reviewError: string | null = null;
  let v2LockDeferrals = 0;
  let v2PendingLocks = 0;
  let v2LockedPredictions = 0;
  let v2LockedNoCalls = 0;
  let v2ConfirmedSeen = 0;
  let v2ConfirmationTimingError: string | null = null;
  let v2ErrataLoadError: string | null = null;
  let v2PublicationAttempted = false;
  let v2PublicationSucceeded = false;
  let v2PublicationError: string | null = null;

  const schedulerHealthFailures = [
    options.stablecoinsCacheSafe ? null : "stablecoins-cache-unsafe",
    options.depegPipelineHealthy ? null : "depeg-pipeline-unhealthy",
  ].filter((reason): reason is string => reason != null);
  if (schedulerHealthFailures.length > 0) {
    v2LockDeferrals = await recordSystemHealthDeferrals({
      stores: storeContracts,
      db,
      incidentsByEventId,
      activeRows,
      nowSec,
      ddrRunId: options.ddrRunId,
      runAt: options.runAt,
      syncCapabilities: options.syncCapabilities,
      reason: schedulerHealthFailures.join(","),
    });
    return {
      itemCount: 0,
      metadata: JSON.stringify({
        ddrRunId: options.ddrRunId,
        activeEvents: activeRows.length,
        degraded: true,
        degradedReason: schedulerHealthFailures.join(","),
        v2LockDeferrals,
        v2FreezeSkipped: true,
        v2PublicationAttempted: false,
      }),
    };
  }

  const confirmationTiming = await loadPendingPromotionConfirmationTimes(db, activeRows);
  v2ConfirmationTimingError = confirmationTiming.error;
  applyConfirmationTimes(incidentsByEventId, confirmationTiming.byEventId);

  if (activeRows.length > 0) {
    const currentDeviation = await buildCurrentDeviationMap(db, nowSec);
    if (!currentDeviation.healthy) {
      v2LockDeferrals = await recordSystemHealthDeferrals({
        stores: storeContracts,
        db,
        incidentsByEventId,
        activeRows,
        nowSec,
        ddrRunId: options.ddrRunId,
        runAt: options.runAt,
        syncCapabilities: options.syncCapabilities,
        reason: currentDeviation.degradedReason ?? "stablecoins-cache-unusable",
      });
      return {
        itemCount: 0,
        metadata: JSON.stringify({
          ddrRunId: options.ddrRunId,
          activeEvents: activeRows.length,
          degraded: true,
          degradedReason: currentDeviation.degradedReason,
          v2LockDeferrals,
          v2FreezeSkipped: true,
          v2PublicationAttempted: false,
        }),
      };
    }

    const active: DdrActiveEventInput[] = activeRows.map((r) => ({
      id: r.id,
      stablecoinId: r.stablecoin_id,
      symbol: r.symbol,
      pegType: r.peg_type,
      direction: r.direction === "above" ? "above" : "below",
      peakDeviationBps: r.peak_deviation_bps,
      startedAt: r.started_at,
      pegReference: r.peg_reference,
      currentDeviationBps: currentDeviation.byCoin.get(r.stablecoin_id) ?? null,
    }));
    const activeCoinIds = [...new Set(active.map((a) => a.stablecoinId))];
    const directions = [...new Set(active.map((a) => a.direction))];

    abortIf(options.signal, "compute-depeg-resolver");

    // 2. Historical recovered/closed events for grouping (training window, matching directions).
    const windowStart = nowSec - TRAINING_WINDOW_SEC;
    const histResult = await db
      .prepare(
        "SELECT stablecoin_id, direction, peak_deviation_bps, started_at, ended_at, recovery_price " +
          "FROM depeg_events WHERE ended_at IS NOT NULL AND started_at >= ? " +
          `AND direction IN (${placeholders(directions.length)}) LIMIT ${HISTORICAL_ROW_CAP}`,
      )
      .bind(windowStart, ...directions)
      .all<{
        stablecoin_id: string;
        direction: string;
        peak_deviation_bps: number;
        started_at: number;
        ended_at: number | null;
        recovery_price: number | null;
      }>();
    const histRows = histResult.results ?? [];
    const historical: DdrHistoricalEvent[] = histRows.map((r) => ({
      stablecoinId: r.stablecoin_id,
      direction: r.direction === "above" ? "above" : "below",
      peakDeviationBps: r.peak_deviation_bps,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      recoveryPrice: r.recovery_price,
    }));

    const incidents: DdrIncident[] = groupIncidents(historical, currencyOf).map((inc) => ({
      ...inc,
      structural: classOf(inc.stablecoinId),
    }));
    const quarantined = quarantinedCoins(incidents);

    abortIf(options.signal, "compute-depeg-resolver");

    // 3. Context: supply history + latest DEWS + latest DEX liquidity for active coins.
    const supplyResult = await queryRows("supply_history", () => db
      .prepare(
        `SELECT stablecoin_id, snapshot_date, circulating_usd FROM supply_history ` +
          `WHERE stablecoin_id IN (${placeholders(activeCoinIds.length)}) ORDER BY stablecoin_id, snapshot_date ASC`,
      )
      .bind(...activeCoinIds)
      .all<{ stablecoin_id: string; snapshot_date: number; circulating_usd: number }>());
    const supplyByCoin = new Map<string, { date: number; usd: number }[]>();
    for (const s of supplyResult.rows) {
      const list = supplyByCoin.get(s.stablecoin_id) ?? [];
      list.push({ date: s.snapshot_date, usd: s.circulating_usd });
      supplyByCoin.set(s.stablecoin_id, list);
    }

    const dewsResult = await queryRows("stress_signals", () => db
      .prepare(
        `SELECT s.stablecoin_id, s.score, s.band, s.computed_at FROM stress_signals s ` +
          `JOIN (SELECT stablecoin_id, MAX(computed_at) mc FROM stress_signals ` +
          `WHERE stablecoin_id IN (${placeholders(activeCoinIds.length)}) GROUP BY stablecoin_id) m ` +
          `ON s.stablecoin_id = m.stablecoin_id AND s.computed_at = m.mc`,
      )
      .bind(...activeCoinIds)
      .all<{ stablecoin_id: string; score: number; band: string; computed_at: number }>());
    const dewsByCoin = new Map(dewsResult.rows.map((d) => [d.stablecoin_id, d]));

    const liqResult = await queryRows("dex_liquidity", () => db
      .prepare(
        `SELECT stablecoin_id, liquidity_score, concentration_hhi, updated_at FROM dex_liquidity ` +
          `WHERE stablecoin_id IN (${placeholders(activeCoinIds.length)})`,
      )
      .bind(...activeCoinIds)
      .all<{ stablecoin_id: string; liquidity_score: number | null; concentration_hhi: number | null; updated_at: number }>());
    const liqByCoin = new Map(liqResult.rows.map((l) => [l.stablecoin_id, l]));

    const redemptionResult = await queryRows("redemption_backstop", () => db
      .prepare(
        `SELECT stablecoin_id, immediate_capacity_ratio, route_family, updated_at FROM redemption_backstop ` +
          `WHERE stablecoin_id IN (${placeholders(activeCoinIds.length)})`,
      )
      .bind(...activeCoinIds)
      .all<{
        stablecoin_id: string;
        immediate_capacity_ratio: number | null;
        route_family: string | null;
        updated_at: number;
      }>());
    const redemptionByCoin = new Map(redemptionResult.rows.map((r) => [r.stablecoin_id, r]));

    const resolverHealthFailures = [
      supplyResult.error,
      dewsResult.error,
      liqResult.error,
      redemptionResult.error,
    ].filter((reason): reason is string => reason != null);
    if (resolverHealthFailures.length > 0) {
      v2LockDeferrals = await recordSystemHealthDeferrals({
        stores: storeContracts,
        db,
        incidentsByEventId,
        activeRows,
        nowSec,
        ddrRunId: options.ddrRunId,
        runAt: options.runAt,
        syncCapabilities: options.syncCapabilities,
        reason: resolverHealthFailures.join(","),
      });
      return {
        itemCount: 0,
        metadata: JSON.stringify({
          ddrRunId: options.ddrRunId,
          activeEvents: activeRows.length,
          degraded: true,
          degradedReason: resolverHealthFailures.join(","),
          v2LockDeferrals,
          v2FreezeSkipped: true,
          v2PublicationAttempted: false,
        }),
      };
    }

    abortIf(options.signal, "compute-depeg-resolver");

    v2ConfirmedSeen = await recordConfirmedSeenOpportunities({
      stores: storeContracts,
      db,
      activeRows,
      incidentsByEventId,
      confirmedAtByEventId: confirmationTiming.byEventId,
      ddrRunId: options.ddrRunId,
      runAt: options.runAt,
      syncCapabilities: options.syncCapabilities,
    });

    rows = active.map((ev) => {
      const meta = TRACKED_META_BY_ID.get(ev.stablecoinId);
      const coin = meta ? toStructural(meta) : fallbackStructural(ev.stablecoinId, ev.symbol, ev.pegType);
      const supply = buildSupplyContext(supplyByCoin.get(ev.stablecoinId) ?? [], ev.startedAt);
      const dews = dewsByCoin.get(ev.stablecoinId);
      const liq = liqByCoin.get(ev.stablecoinId);
      const redemption = redemptionByCoin.get(ev.stablecoinId);
      const dewsFresh = dews != null && nowSec - dews.computed_at <= DEWS_MAX_AGE_SEC;
      const liqFresh = liq != null && nowSec - liq.updated_at <= DEX_LIQUIDITY_MAX_AGE_SEC;
      const redemptionFresh = redemption != null && nowSec - redemption.updated_at <= REDEMPTION_BACKSTOP_MAX_AGE_SEC;
      const live: DdrLiveContext = {
        dewsBand: dewsFresh ? dews.band : null,
        dewsScore: dewsFresh ? dews.score : null,
        liquidityScore: liqFresh ? liq.liquidity_score : null,
        concentrationHhi: liqFresh ? liq.concentration_hhi : null,
        redemptionCapacityRatio: redemptionFresh ? redemption.immediate_capacity_ratio : null,
        redemptionRouteFamily: redemptionFresh ? redemption.route_family : null,
      };
      return resolveDepeg({ active: ev, coin, supply, live, nowSec, incidents, quarantined });
    });

    lineage = {
      trainingWindow: { start: windowStart, end: nowSec },
      eventCount: historical.length,
      incidentCount: incidents.length,
      coinCount: new Set(incidents.map((i) => i.stablecoinId)).size,
      quarantinedCoins: quarantined.size,
    };
  }

  const diagnosticSnapshot: DdrDiagnosticResponse = {
    _meta: {
      schemaVersion: 2,
      dataAsOf: nowSec,
      modelAsOf: nowSec,
      computedAt: nowSec,
      expiresAt: nowSec + 1800,
      snapshotToken: null,
      snapshotGeneration: null,
      publicPredictionIds: [],
      publicPredictionRowHashes: {},
      basePayloadHash: null,
      readOverlay: {
        degradedLockDeferralIncidentKeys: [],
        closedPendingReviewIncidentKeys: [],
        suppressedIncidentKeys: [],
      },
      degraded: false,
      degradedReason: null,
      publicWarning: DDR_PUBLIC_WARNING,
      resolutionRubricVersion: DDR_RESOLUTION_RUBRIC_VERSION,
      durationModelVersion: DDR_DURATION_MODEL_VERSION,
      incidentGroupingVersion: DDR_INCIDENT_GROUPING_VERSION,
      supportRulesVersion: DDR_SUPPORT_RULES_VERSION,
      lineage,
    },
    rows,
    methodology: buildMethodologyEnvelope({
      version: DDR_METHODOLOGY_VERSION,
      versionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      currentVersion: DDR_METHODOLOGY_VERSION,
      currentVersionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      changelogPath: DDR_METHODOLOGY_CHANGELOG_PATH,
      asOf: nowSec,
    }),
  };

  const activeEventById = new Map(activeRows.map((row) => [row.id, row]));
  const activeIncidentKeys = [...new Set(activeRows.map((row) => incidentsByEventId.get(row.id)?.incidentKey).filter((key): key is string => key != null))];
  const publicationState = await loadSealedAndPublicationState({
    stores: storeContracts,
    db,
    incidentKeys: activeIncidentKeys,
  });
  const lockResult = await sealEligibleLocks({
    stores: storeContracts,
    db,
    rows,
    activeEventById,
    incidentsByEventId,
    existingSealed: publicationState.sealed,
    nowSec,
    ddrRunId: options.ddrRunId,
    runAt: options.runAt,
    syncCapabilities: options.syncCapabilities,
  });
  v2LockedPredictions = lockResult.lockedCount;
  v2LockedNoCalls = lockResult.noCallCount;
  v2PendingLocks = lockResult.pendingCount;

  const refreshedPublicationState = storeContracts
    ? await loadSealedAndPublicationState({ stores: storeContracts, db, incidentKeys: activeIncidentKeys })
    : { sealed: lockResult.sealed, firstPublication: publicationState.firstPublication };
  const errataState = await loadErrataForSealedPredictions({
    stores: storeContracts,
    db,
    sealed: refreshedPublicationState.sealed,
  });
  v2ErrataLoadError = errataState.error;

  const publication = await writePublicationBeforeCache({
    stores: storeContracts,
    db,
    snapshot: diagnosticSnapshot,
    incidentsByEventId,
    sealed: refreshedPublicationState.sealed,
    firstPublication: refreshedPublicationState.firstPublication,
    errata: errataState.errata,
    ddrRunId: options.ddrRunId,
    nowSec,
  });
  v2PublicationAttempted = publication.attempted;
  v2PublicationSucceeded = publication.ok;
  v2PublicationError = publication.error;

  const publicSnapshot = buildDdrResponse({
    candidateRows: rows,
    incidentsByEventId,
    sealed: refreshedPublicationState.sealed,
    firstPublication: publication.firstPublication,
    manifest: publication.manifest,
    errata: errataState.errata,
    lineage,
    nowSec,
    storageAvailable: storeContracts != null,
  });
  if (publication.attempted && !publication.ok) {
    publicSnapshot._meta.degraded = true;
    publicSnapshot._meta.degradedReason = `publication-retry-pending:${publication.error ?? "manifest-write-failed"}`;
  }
  await writeDepegResolverSnapshot(db, publicSnapshot);
  const reviewArtifacts = await persistDepegResolverReviewArtifacts(db, diagnosticSnapshot, options.signal, storeContracts);
  assessmentWriteCount = reviewArtifacts.assessmentWriteCount;
  reviewRows = reviewArtifacts.reviewRows;
  reviewError = reviewArtifacts.reviewError;

  return {
    itemCount: rows.length,
    metadata: JSON.stringify({
      ddrRunId: options.ddrRunId,
      activeEvents: rows.length,
      assessmentWriteCount,
      reviewRows,
      ddrrDegraded: reviewError != null,
      ddrrDegradedReason: reviewError,
      incidentCount: lineage?.incidentCount ?? 0,
      quarantinedCoins: lineage?.quarantinedCoins ?? 0,
      v2PolicyUniverseEvents: policyUniverseRows.length,
      v2CanonicalIncidents: new Set([...incidentsByEventId.values()].map((incident) => incident.incidentKey)).size,
      v2PendingLocks,
      v2LockedPredictions,
      v2LockedNoCalls,
      v2ConfirmedSeen,
      v2ConfirmationTimingError,
      v2PublicationAttempted,
      v2PublicationSucceeded,
      v2PublicationError,
      v2ErrataLoadError,
    }),
  };
}
