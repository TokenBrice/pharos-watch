import { formatIsoDate } from "@shared/lib/format";
import { evaluateReferenceAdmission, heldCloseBenchmarkExtensionSec, OXR_POLL_INTERVAL_SEC, REFERENCE_INTRADAY_BUDGET_SEC } from "@shared/lib/reference-admission";
import { getReferenceSessionState } from "@shared/lib/reference-market-hours";
import { FxReferenceObservationSchema, type FxReferenceObservation, type FxReferenceObservationMap } from "@shared/types/fx-reference";
import { CIRCUIT_SOURCE } from "../lib/constants";
import { fetchRealtimeFxRates, getRealtimeFxTimestampRejection, type RealtimeFxObservation } from "../lib/fx-realtime";
import { fetchChainlinkReferenceQuoteSnapshot, type ChainlinkReferenceQuote, type ChainlinkReferenceQuoteSnapshot } from "../lib/chainlink-feeds";
import type { ChainRpcConfig } from "../lib/chain-registry";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import { getCache, getCacheUpdatedAt, setCache } from "../lib/db-cache";
import type { MetalPegKey, MetalsResolution } from "../lib/fx-metals";
import type { FxRateSourceMode, FxRateState, FxRateSyncMode, FxRatesMeta, FxSourceCadence } from "../lib/fx-rate-state";
import { assessEcbRelease, getEcbFixingClocks, getFxSourceStatus, hasVerifiedLegacyRate, isAdmissibleFxSourceDate, isFreshFxObservation, persistFxRateState } from "../lib/fx-rate-state";
import { fxSourceSampleKey, recordFxSourceSample, type FxBaseline, type FxMedianContributorsByPeg, type FxReferenceSourceSamples } from "../lib/fx-observations";
import { logCronEvent, type CronEventInput, type CronResult } from "../lib/cron-logger";
import {
  canCarryForwardFxRates,
  inheritFxSourceMetadata,
} from "../lib/fx-source-metadata";
import { invertUnitsPerUsd, MAX_FX_RATE_DELTA_PCT, OXR_LAST_SUCCESS_KEY } from "../lib/fx-config";
import { toErrorMessage } from "@shared/lib/error-utils";

const CHAINLINK_FAILING_RUNS_CACHE_KEY = "chainlink:failing-runs";
const CHAINLINK_REFERENCE_MAX_DIVERGENCE = 0.05;
const REALTIME_OVERLAY_MAX_DIVERGENCE = 0.05;
// Two independently published indicative midpoint blends must agree on the new regime.
const FX_REGIME_CORROBORATION_MAX_DIVERGENCE = 0.02;
const CHAINLINK_METAL_PEG_KEYS = new Set<string>(["peggedGOLD", "peggedSILVER"]);
const OXR_LAST_ATTEMPT_KEY = "fx-oxr-last-attempt";

function referenceWins(
  candidateAt: number | null | undefined, candidateCadence: FxSourceCadence | undefined,
  incumbentAt: number, incumbentCadence: FxSourceCadence | undefined,
): boolean {
  return candidateAt != null && (candidateAt > incumbentAt
    || (candidateAt === incumbentAt && (candidateCadence === "intraday" || incumbentCadence !== "intraday")));
}

function keepDatedIncumbent(
  candidateAt: number | null | undefined, candidateCadence: FxSourceCadence | undefined, candidateFresh: boolean,
  incumbentAt: number, incumbentCadence: FxSourceCadence | undefined, incumbentFresh: boolean,
): boolean {
  if (candidateFresh !== incumbentFresh) return incumbentFresh;
  return !referenceWins(candidateAt, candidateCadence, incumbentAt, incumbentCadence);
}

function observationDate(observation: FxReferenceObservation): string | null {
  return observation.cadence === "intraday" ? null : formatIsoDate(observation.observedAtSec);
}

function isObservationFreshAt(observation: FxReferenceObservation, atSec: number): boolean {
  return observation.observedAtSec <= atSec && isFreshFxObservation(observation.observedAtSec, "live", atSec, {
    pegKey: observation.pegKey, cadence: observation.cadence, sourceDate: observationDate(observation),
  });
}

function isChainlinkMetalPegKey(pegKey: string): pegKey is MetalPegKey {
  return CHAINLINK_METAL_PEG_KEYS.has(pegKey);
}

async function loadChainlinkFailingRuns(db: D1Database): Promise<Record<string, number> | undefined> {
  const cached = await getCache(db, CHAINLINK_FAILING_RUNS_CACHE_KEY);
  if (!cached) return undefined;
  try {
    const parsed = JSON.parse(cached.value);
    return typeof parsed === "object" && parsed != null && !Array.isArray(parsed)
      ? (parsed as Record<string, number>)
      : undefined;
  } catch {
    return undefined;
  }
}

export interface SecondaryCurrencyPayload {
  date?: string;
  usd: Record<string, number>;
}

export type SecondaryCurrencyEndpoint = "jsdelivr" | "jsdelivr-versioned" | "pages.dev";

export interface SecondaryCurrencyCandidate {
  endpoint: SecondaryCurrencyEndpoint;
  payload: SecondaryCurrencyPayload;
}

export type SecondaryFxMappings = ReadonlyArray<readonly [string, string]>;

export interface ExchangeRateApiPayload {
  result?: string;
  time_last_update_unix?: number;
  time_last_update_utc?: string;
  rates: Record<string, number>;
}

export type RunBestEffort = (label: string, fn: () => Promise<void>) => Promise<void>;
type FxCronEvent = Omit<CronEventInput, "job">;

export type OpenExchangeRatesSourceStatus = "ok" | "partial" | "rate-limited" | "unavailable" | "skipped";
export type ChainlinkSourceStatus = "ok" | "partial" | "out-of-budget" | "unavailable";

async function withFxOverlayCircuit<TStatus>(
  db: D1Database,
  options: {
    source: (typeof CIRCUIT_SOURCE)[keyof typeof CIRCUIT_SOURCE];
    circuitOpenEvent: FxCronEvent;
    failedEvent: FxCronEvent;
    failureOutcomeLabel: string;
    signal: AbortSignal | undefined;
    runBestEffort: RunBestEffort;
    run: () => Promise<TStatus>;
  },
): Promise<TStatus | "unavailable"> {
  if (!(await shouldAttemptFetch(db, options.source))) {
    await logCronEvent(db, {
      job: "sync-fx-rates",
      ...options.circuitOpenEvent,
    });
    return "unavailable";
  }

  try {
    return await options.run();
  } catch (err) {
    if (options.signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    await logCronEvent(db, {
      job: "sync-fx-rates",
      ...options.failedEvent,
      metadata: {
        ...options.failedEvent.metadata,
        error: toErrorMessage(err),
      },
    });
    await options.runBestEffort(options.failureOutcomeLabel, async () => {
      await recordOutcome(db, options.source, false);
    });
    return "unavailable";
  }
}

export async function persistFxSyncResult(
  db: D1Database,
  state: FxSyncRunState,
  meta: FxRatesMeta,
  syncStartSec: number,
  secondaryPegKeys: string[],
): Promise<CronResult> {
  const cacheResult = await persistFxRateState(db, state.usableRates, meta, syncStartSec);
  const canonicalCache = cacheResult.written ? null : await getCache(db, "fx-rates");
  const lastWriteAdvanced = cacheResult.written || (!!canonicalCache && canonicalCache.updatedAt > syncStartSec);
  await state.flushCronEvents(db, cacheResult.written);
  await logCronEvent(db, {
    job: "sync-fx-rates",
    eventType: cacheResult.written ? "fx-rates-cache-published" : "fx-rates-cache-write-skipped",
    severity: "info",
    message: cacheResult.written
      ? "Cached FX rates."
      : "Cache write skipped because a newer FX rates row exists.",
    metadata: {
      rates: state.usableRates,
      cacheWriteMode: cacheResult.written ? "published" : "skipped-newer",
      syncStartSec,
    },
  });
  const repeatedCachedFallback =
    state.mode === "cached-fallback" && meta.consecutiveFallbackRuns >= 4;
  const degradedReason = state.degradedReason
    ?? (repeatedCachedFallback ? "repeated-cached-fallback" : undefined);
  return {
    status: degradedReason ? "degraded" : undefined,
    itemCount: cacheResult.written ? Object.keys(state.usableRates).length : 0,
    metadata: JSON.stringify({
      ...state.buildResultMetadata(secondaryPegKeys),
      reason: degradedReason,
      cacheWriteMode: cacheResult.written ? "published" : "skipped-newer",
      casSkipped: cacheResult.skippedBecauseNewer,
      cacheKey: "fx-rates",
      syncStartSec,
      cacheWriteSucceeded: cacheResult.written,
      lastWriteAdvanced,
    }),
  };
}

interface FxSyncRunStateParams {
  prevState: FxRateState | null;
  syncStartSec: number;
  expectedPegKeys: string[];
  initialSources: Record<string, string>;
  validateRate: (pegKey: string, rate: number, prevRate: number | undefined) => boolean;
}

interface ApplyInverseRateMappingsInput {
  mappings: SecondaryFxMappings;
  includeMissingPrevious?: boolean;
  sourceUpdatedAt: number | null;
  sourceDate: string | null;
  cadence: FxSourceCadence;
  source: FxReferenceObservation["source"];
  publishedAtSec?: number;
  getPerUsd(currency: string): number | undefined;
}

interface ApplyPerUsdPayloadInput<TPayload> {
  payload: TPayload;
  mappings: SecondaryFxMappings;
  includeMissingPrevious?: boolean;
  cadence: FxSourceCadence;
  source: FxReferenceObservation["source"];
  resolveSourceMeta(payload: TPayload): {
    sourceUpdatedAt: number | null;
    sourceDate: string | null;
  };
  getPerUsd(payload: TPayload, currency: string): number | undefined;
}

function resolveDatedSourceUpdatedAt(
  dateText: string | null | undefined,
  syncStartSec: number,
): number | null {
  if (!isAdmissibleFxSourceDate(dateText, syncStartSec)) return null;
  return Date.parse(`${dateText}T00:00:00Z`) / 1000;
}

export class FxSyncRunState {
  readonly prevState: FxRateState | null;
  readonly prevRates: Record<string, number>;
  readonly syncStartSec: number;
  readonly expectedPegKeys: string[];
  private readonly cronEvents: FxCronEvent[] = [];
  readonly validateRate: FxSyncRunStateParams["validateRate"];

  readonly sourceUpdatedAtByPeg: Record<string, number | null> = {};
  readonly sourceModeByPeg: Record<string, FxRateSourceMode> = {};
  readonly sourceCadenceByPeg: Record<string, FxSourceCadence> = {};
  readonly sourceDateByPeg: Record<string, string | null> = {};
  private readonly observations: FxReferenceObservationMap = {};
  private readonly legacyDetectionPegs = new Set<string>();
  private readonly offeredPegKeys = new Set<string>();
  private readonly referenceMedianContributorsByPeg: FxMedianContributorsByPeg = {};
  private readonly correctedLegacyFixings: FxReferenceObservationMap = {};
  private readonly dailyObservations: FxReferenceObservationMap;
  private readonly baselines: Record<string, FxBaseline>;
  private readonly referenceSourceSamples: FxReferenceSourceSamples;
  private readonly pendingRegimePegs = new Set<string>();
  private readonly regimeCandidates: FxReferenceObservationMap = {};
  private readonly previousRegimeByPeg: NonNullable<FxRatesMeta["previousRegimeByPeg"]>;
  private readonly provisionalRealtimeOverlayPegs = new Set<string>();

  usableRates: Record<string, number> = {};
  mode: FxRateSyncMode = "live";
  ecbDate: string | null = null;
  fallbackMode: string | undefined;
  validationIssues: string | undefined;
  degradedReason: string | undefined;
  sources: Record<string, string>;

  constructor(params: FxSyncRunStateParams) {
    this.prevState = params.prevState;
    this.prevRates = params.prevState?.rates ?? {};
    this.syncStartSec = params.syncStartSec;
    this.expectedPegKeys = [...params.expectedPegKeys];
    this.validateRate = params.validateRate;
    this.sources = { ...params.initialSources };
    const verified = params.prevState?.metadataIdentity === "verified" ? params.prevState : null;
    this.referenceSourceSamples = { ...verified?.referenceSourceSamples };
    this.previousRegimeByPeg = { ...params.prevState?.previousRegimeByPeg };
    this.dailyObservations = { ...verified?.dailyObservations };
    this.baselines = { ...params.prevState?.lastAcceptedBaselines };
    for (const [pegKey, usdPerUnit] of Object.entries(this.prevRates)) {
      this.baselines[pegKey] ??= { usdPerUnit, observedAtSec: params.prevState?.sourceUpdatedAtByPeg[pegKey] ?? null };
    }
    for (const observation of Object.values(verified?.observations ?? {})) {
      if (observation.cadence !== "intraday") this.rememberDaily(observation);
    }
  }

  private recordCronEvent(event: FxCronEvent): void {
    this.cronEvents.push(event);
  }

  async flushCronEvents(db: D1Database, published = false): Promise<void> {
    const events = this.cronEvents.splice(0);
    for (const event of events) {
      const publicationEvent = event.eventType === "fx-regime-shift-confirmed" || event.eventType === "fx-reference-regression";
      if (publicationEvent && !published) continue;
      await logCronEvent(db, { job: "sync-fx-rates", ...event,
        ...(publicationEvent ? { metadata: { ...event.metadata, publishedGeneration: this.syncStartSec } } : {}),
      });
    }
  }

  private previousUsesLegacyDetection(pegKey: string): boolean {
    const prior = this.prevState;
    if (!prior || !(pegKey in prior.rates) ||
      (prior.metadataIdentity !== "verified" && prior.metadataIdentity !== "legacy-timestamp")) return false;
    return prior.legacyDetectionPegs?.includes(pegKey) === true ||
      (prior.observations === undefined && prior.legacyRepricingByPeg === undefined && !prior.sources?.[pegKey]);
  }

  markLive(
    pegKey: string,
    updatedAt: number | null,
    cadence: FxSourceCadence = "intraday",
    sourceDate: string | null = null,
    source?: FxReferenceObservation["source"],
    publishedAtSec?: number,
  ): void {
    this.sourceUpdatedAtByPeg[pegKey] = updatedAt;
    this.sourceModeByPeg[pegKey] = "live";
    this.sourceCadenceByPeg[pegKey] = cadence;
    this.sourceDateByPeg[pegKey] = sourceDate;
    this.legacyDetectionPegs.delete(pegKey);
    delete this.observations[pegKey];
    delete this.referenceMedianContributorsByPeg[pegKey];
    if (source && updatedAt != null) {
      const observation = { pegKey, usdPerUnit: this.usableRates[pegKey], source, cadence, observedAtSec: updatedAt, publishedAtSec };
      const parsed = FxReferenceObservationSchema.safeParse(observation);
      if (parsed.success && updatedAt <= this.syncStartSec) {
        this.observations[pegKey] = parsed.data;
        recordFxSourceSample(this.referenceSourceSamples, parsed.data, isObservationFreshAt);
        const evidence = this.referenceSourceSamples[fxSourceSampleKey(parsed.data)]?.evidence;
        const previous = this.prevState?.observations?.[pegKey];
        // A main-format cache has no prior OXR sample. Keep compatibility for its first snapshot and rereads.
        if (source === "openExchangeRates" && this.previousUsesLegacyDetection(pegKey) &&
          evidence?.firstInSessionObservedAtSec === updatedAt && evidence.preCloseUsdPerUnit === null &&
          (!previous || (previous.source === source && previous.observedAtSec === updatedAt))) {
          this.legacyDetectionPegs.add(pegKey);
        }
      }
    }
  }

  private selectObservation(observation: FxReferenceObservation): void {
    const { pegKey, usdPerUnit, observedAtSec, cadence, source, publishedAtSec } = observation;
    this.usableRates[pegKey] = usdPerUnit;
    this.markLive(pegKey, observedAtSec, cadence, observationDate(observation), source, publishedAtSec);
  }

  private rememberDaily(observation: FxReferenceObservation): void {
    const key = fxSourceSampleKey(observation);
    const prior = this.dailyObservations[key];
    if (!prior || observation.observedAtSec >= prior.observedAtSec) {
      this.dailyObservations[key] = observation;
    }
  }

  inheritPrevious(pegKey: string): void {
    const corrected = this.correctedLegacyFixings[pegKey];
    if (corrected) {
      this.selectObservation(corrected);
      return;
    }
    inheritFxSourceMetadata(
      this.prevState,
      pegKey,
      this.sourceUpdatedAtByPeg,
      this.sourceModeByPeg,
      this.sourceCadenceByPeg,
      this.sourceDateByPeg,
    );
    const verified = this.prevState?.metadataIdentity === "verified" ? this.prevState : null;
    const previous = verified?.observations?.[pegKey];
    if (this.previousUsesLegacyDetection(pegKey) && this.prevRates[pegKey] === this.usableRates[pegKey]) this.legacyDetectionPegs.add(pegKey);
    else this.legacyDetectionPegs.delete(pegKey);
    if (previous) this.observations[pegKey] = previous;
    else delete this.observations[pegKey];
    const contributors = verified?.referenceMedianContributorsByPeg?.[pegKey];
    if (contributors) this.referenceMedianContributorsByPeg[pegKey] = contributors;
    else delete this.referenceMedianContributorsByPeg[pegKey];
  }

  private previousReferenceClock(pegKey: string): number | null {
    return this.correctedLegacyFixings[pegKey]?.observedAtSec ?? this.prevState?.sourceUpdatedAtByPeg[pegKey] ?? null;
  }

  private previousSourceStatus(pegKey: string) {
    const prev = this.prevState;
    return getFxSourceStatus(prev?.sourceUpdatedAtByPeg[pegKey] ?? null, prev?.sourceModeByPeg[pegKey], this.syncStartSec, {
      pegKey, cadence: prev?.sourceCadenceByPeg[pegKey], sourceDate: prev?.sourceDateByPeg[pegKey],
      legacy: prev?.observations === undefined || hasVerifiedLegacyRate(prev, pegKey),
    });
  }

  private previousIsFresh(pegKey: string): boolean {
    const corrected = this.correctedLegacyFixings[pegKey];
    if (corrected) return isObservationFreshAt(corrected, this.syncStartSec);
    const observedAt = this.previousReferenceClock(pegKey);
    return observedAt != null && observedAt <= this.syncStartSec && this.previousSourceStatus(pegKey) === "fresh";
  }

  private currentSourceStatus(pegKey: string) {
    return getFxSourceStatus(this.sourceUpdatedAtByPeg[pegKey] ?? null, this.sourceModeByPeg[pegKey], this.syncStartSec, {
      pegKey, cadence: this.sourceCadenceByPeg[pegKey], sourceDate: this.sourceDateByPeg[pegKey],
      legacy: this.legacyDetectionPegs.has(pegKey) && !this.observations[pegKey],
    });
  }

  private currentIsFresh(pegKey: string): boolean {
    const observedAt = this.sourceUpdatedAtByPeg[pegKey];
    return observedAt != null && observedAt <= this.syncStartSec && this.currentSourceStatus(pegKey) === "fresh";
  }

  private canCorroborate(pegKey: string, rate: number, observedAtSec: number): boolean {
    const baseline = this.baselines[pegKey];
    return baseline != null && (baseline.observedAtSec == null || observedAtSec > baseline.observedAtSec)
      && !this.previousIsFresh(pegKey) && this.validateRate(pegKey, rate, undefined);
  }

  hasRegimeCandidates(): boolean {
    return Object.keys(this.regimeCandidates).length > 0;
  }

  confirmRegimeChanges(payload: ExchangeRateApiPayload | null, mappings: SecondaryFxMappings): void {
    const timestamp = payload?.time_last_update_unix;
    const confirmedAt = timestamp != null && Number.isSafeInteger(timestamp) && timestamp > 0 && timestamp <= this.syncStartSec
      ? timestamp : null;
    const sourceDate = confirmedAt == null ? null : new Date(confirmedAt * 1000).toISOString().slice(0, 10);
    for (const [currency, pegKey] of mappings) {
      const candidate = this.regimeCandidates[pegKey];
      if (!candidate) continue;
      const previous = this.baselines[pegKey];
      const perUsd = payload?.rates[currency.toUpperCase()];
      if (confirmedAt == null || (previous.observedAtSec != null && confirmedAt <= previous.observedAtSec)
        || !isFreshFxObservation(confirmedAt, "live", this.syncStartSec, { pegKey, cadence: "calendar-daily", sourceDate })
        || perUsd == null || !Number.isFinite(perUsd) || perUsd <= 0) continue;
      const rate = invertUnitsPerUsd(perUsd);
      if (!this.validateRate(pegKey, rate, undefined)
        || Math.abs(rate - candidate.usdPerUnit) / candidate.usdPerUnit > FX_REGIME_CORROBORATION_MAX_DIVERGENCE) continue;

      const confirmation: FxReferenceObservation = {
        pegKey, usdPerUnit: rate, observedAtSec: confirmedAt, source: "exchangeRateApi", cadence: "calendar-daily",
      };
      const replacement = confirmedAt > candidate.observedAtSec ? confirmation : candidate;
      this.rememberDaily(confirmation);
      recordFxSourceSample(this.referenceSourceSamples, candidate, isObservationFreshAt);
      recordFxSourceSample(this.referenceSourceSamples, confirmation, isObservationFreshAt);
      this.selectObservation(replacement);
      this.baselines[pegKey] = replacement;
      this.previousRegimeByPeg[pegKey] = { previous, replacement };
      this.pendingRegimePegs.delete(pegKey);
      this.recordCronEvent({
        eventType: "fx-regime-shift-confirmed",
        severity: "warning",
        message: "Replaced an expired FX baseline after two current fiat providers agreed.",
        metadata: { pegKey, previous, candidate, confirmation, generation: this.syncStartSec },
      });
    }
    for (const candidate of Object.values(this.regimeCandidates)) {
      if (!this.pendingRegimePegs.has(candidate.pegKey)) continue;
      this.recordCronEvent({
        eventType: "fx-regime-shift-unconfirmed",
        severity: "warning",
        message: "An expired FX baseline may have shifted and independent corroboration is unavailable.",
        metadata: { pegKey: candidate.pegKey, observedAtSec: candidate.observedAtSec, generation: this.syncStartSec },
      });
    }
  }

  private correctLegacyFixing(candidate: FxReferenceObservation): void {
    if (candidate.source !== "frankfurter") return;
    const { pegKey, usdPerUnit, observedAtSec } = candidate;
    const fixingDate = observationDate(candidate);
    const legacyAt = this.prevState?.sourceUpdatedAtByPeg[pegKey];
    if (!(this.prevState?.sourceCadenceByPeg[pegKey] === "business-daily"
      && fixingDate != null && this.prevState.sourceDateByPeg[pegKey] === fixingDate
      && !this.prevState.observations?.[pegKey] && this.prevRates[pegKey] === usdPerUnit)) return;
    // The legacy writer used 16:00 UTC, capped at its own generation clock.
    const legacyFixingAt = Math.min(Date.parse(`${fixingDate}T16:00:00Z`) / 1000, this.prevState.usableSyncAt);
    if (legacyAt !== legacyFixingAt || legacyAt < observedAtSec) return;
    const baseline = this.baselines[pegKey];
    if (baseline?.usdPerUnit === usdPerUnit && baseline.observedAtSec === this.previousReferenceClock(pegKey)) {
      this.baselines[pegKey] = { usdPerUnit, observedAtSec };
    }
    this.correctedLegacyFixings[pegKey] = candidate;
    if (this.usableRates[pegKey] === usdPerUnit && !this.observations[pegKey]
      && this.sourceUpdatedAtByPeg[pegKey] === this.prevState.sourceUpdatedAtByPeg[pegKey]
      && this.sourceCadenceByPeg[pegKey] === "business-daily"
      && this.sourceDateByPeg[pegKey] === observationDate(candidate)) {
      this.selectObservation(candidate);
    }
  }

  private preferIncumbent(
    pegKey: string, observedAt: number | null, cadence: FxSourceCadence, candidateFresh: boolean,
  ): boolean {
    const prevRate = this.prevRates[pegKey];
    const prevAt = this.previousReferenceClock(pegKey);
    const prevCadence = this.prevState?.sourceCadenceByPeg[pegKey];
    const selectedAt = this.sourceUpdatedAtByPeg[pegKey];
    const selectedCadence = this.sourceCadenceByPeg[pegKey];
    const selectedFresh = this.currentIsFresh(pegKey);
    const previousFresh = this.previousIsFresh(pegKey);
    if (prevAt != null && prevAt <= this.syncStartSec && prevRate > 0
      && keepDatedIncumbent(observedAt, cadence, candidateFresh, prevAt, prevCadence, previousFresh)) {
      if (selectedAt == null || keepDatedIncumbent(selectedAt, selectedCadence, selectedFresh, prevAt, prevCadence, previousFresh)) {
        this.usableRates[pegKey] = prevRate;
        this.inheritPrevious(pegKey);
      }
      return true;
    }
    return selectedAt != null && selectedAt <= this.syncStartSec
      && keepDatedIncumbent(observedAt, cadence, candidateFresh, selectedAt, selectedCadence, selectedFresh);
  }

  enforcePublicationOrder(): void {
    const expiredIntradayPegs: string[] = [];
    for (const pegKey of Object.keys(this.prevRates)) {
      const previousAt = this.previousReferenceClock(pegKey);
      const selectedAt = this.sourceUpdatedAtByPeg[pegKey];
      const previousCadence = this.prevState?.sourceCadenceByPeg[pegKey];
      const selected = this.observations[pegKey];
      const expired = previousCadence === "intraday" && previousAt != null
        && this.syncStartSec - previousAt > REFERENCE_INTRADAY_BUDGET_SEC;
      if (expired && previousAt != null && (this.prevState?.usableSyncAt ?? 0) - previousAt <= REFERENCE_INTRADAY_BUDGET_SEC) {
        expiredIntradayPegs.push(pegKey);
      }
      const previousFresh = this.previousIsFresh(pegKey);
      if (previousAt != null && previousAt <= this.syncStartSec
        && (previousFresh || pegKey in this.usableRates)
        && keepDatedIncumbent(selectedAt, this.sourceCadenceByPeg[pegKey], this.currentIsFresh(pegKey),
          previousAt, previousCadence, previousFresh)) {
        if (previousFresh && selectedAt != null && selectedAt < previousAt && pegKey in this.usableRates) {
          this.recordCronEvent({
            eventType: "fx-reference-regression",
            severity: "error",
            message: "Blocked a publication that regressed an in-budget FX reference.",
            metadata: { pegKey, previousAt, selectedAt, generation: this.syncStartSec },
          });
        }
        this.usableRates[pegKey] = this.prevRates[pegKey];
        this.inheritPrevious(pegKey);
      } else if (expired && selected?.source === "openExchangeRates" && selected.cadence === "intraday" && selectedAt === previousAt) {
        this.clearRate(pegKey);
      }
    }
    for (const daily of Object.values(this.dailyObservations)) {
      const { pegKey, observedAtSec, cadence, usdPerUnit } = daily;
      const selectedAt = this.sourceUpdatedAtByPeg[pegKey];
      if (!isObservationFreshAt(daily, this.syncStartSec)
        || (selectedAt != null && this.currentIsFresh(pegKey)
          && !referenceWins(observedAtSec, cadence, selectedAt, this.sourceCadenceByPeg[pegKey]))
        || !this.validateRate(pegKey, usdPerUnit, this.baselines[pegKey]?.usdPerUnit)) continue;
      this.selectObservation(daily);
    }
    if (expiredIntradayPegs.length > 0) {
      this.recordCronEvent({
        eventType: "fx-intraday-expired",
        severity: "info",
        message: "Previous intraday FX observations exceeded the consumption budget.",
        metadata: { pegKeys: expiredIntradayPegs, budgetSec: REFERENCE_INTRADAY_BUDGET_SEC, generation: this.syncStartSec },
      });
    }
  }

  canCarryForwardPreviousRates(): boolean {
    return canCarryForwardFxRates(
      this.expectedPegKeys,
      this.prevState,
      this.prevRates,
      this.syncStartSec,
    );
  }
  degrade(reason: string): void {
    this.degradedReason ??= reason;
  }

  hasFreshFullFxCoverage(): boolean {
    return this.expectedPegKeys.every((pegKey) => {
      const rate = this.usableRates[pegKey];
      return typeof rate === "number"
        && Number.isFinite(rate)
        && rate > 0
        && getFxSourceStatus(this.sourceUpdatedAtByPeg[pegKey] ?? null, this.sourceModeByPeg[pegKey], this.syncStartSec, {
          pegKey,
          cadence: this.sourceCadenceByPeg[pegKey],
          sourceDate: this.sourceDateByPeg[pegKey] ?? null,
        }) === "fresh";
    });
  }

  private seedCachedFallbackFromPrevious(): void {
    for (const [pegKey, rate] of Object.entries(this.prevRates)) {
      if (pegKey in this.usableRates) continue;
      this.usableRates[pegKey] = rate;
      this.inheritPrevious(pegKey);
    }
    this.ecbDate ??= this.prevState?.ecbDate ?? null;
  }

  private applyInverseRateMappings(input: ApplyInverseRateMappingsInput): void {
    const {
      mappings,
      includeMissingPrevious = false,
      sourceUpdatedAt,
      sourceDate,
      cadence,
      source,
      publishedAtSec,
      getPerUsd,
    } = input;
    const candidateFresh = sourceUpdatedAt != null && sourceUpdatedAt <= this.syncStartSec && isFreshFxObservation(
      sourceUpdatedAt, "live", this.syncStartSec, { cadence, sourceDate },
    );
    const skippedOlderPegKeys: string[] = [];

    for (const [currency, pegKey] of mappings) {
      const prevRate = this.prevRates[pegKey];
      const perUsd = getPerUsd(currency);
      if (perUsd !== undefined) this.offeredPegKeys.add(pegKey);
      if (typeof perUsd === "number" && Number.isFinite(perUsd) && perUsd > 0) {
        const rate = invertUnitsPerUsd(perUsd);
        const valid = this.validateRate(pegKey, rate, this.baselines[pegKey]?.usdPerUnit);
        const observation = candidateFresh && sourceUpdatedAt != null
          ? { pegKey, usdPerUnit: rate, observedAtSec: sourceUpdatedAt, cadence, source, publishedAtSec } : undefined;
        if (valid && observation) {
          this.correctLegacyFixing(observation);
          recordFxSourceSample(this.referenceSourceSamples, observation, isObservationFreshAt);
          if (cadence !== "intraday") this.rememberDaily(observation);
        }
        if (valid && this.preferIncumbent(pegKey, sourceUpdatedAt, cadence, candidateFresh)) {
          if (sourceUpdatedAt != null && sourceUpdatedAt < (this.sourceUpdatedAtByPeg[pegKey] ?? 0)) {
            skippedOlderPegKeys.push(pegKey);
          }
          continue;
        }
        if (valid) {
          this.usableRates[pegKey] = rate;
          this.markLive(pegKey, sourceUpdatedAt, cadence, sourceDate, source, publishedAtSec);
        } else {
          if (observation && this.canCorroborate(pegKey, rate, observation.observedAtSec)) {
            this.pendingRegimePegs.add(pegKey);
            this.recordCronEvent({
              eventType: "fx-regime-shift-unconfirmed", severity: "warning",
              message: "A stale FX baseline may have shifted; independent fiat corroboration is required.",
              metadata: { pegKey, source, sourceUpdatedAt, rate, previous: this.baselines[pegKey] },
            });
          }
          // A rejected live value may only be recovered from a cadence-valid
          // original observation; a stale incumbent is not live coverage (ADR-29).
          this.ensureCachedRate(pegKey, currency, { requireCadenceValid: true });
        }
      } else if (includeMissingPrevious && prevRate) {
        this.usableRates[pegKey] = prevRate;
        this.inheritPrevious(pegKey);
      }
    }

    if (skippedOlderPegKeys.length > 0 && cadence === "calendar-daily") {
      this.recordCronEvent({
        eventType: "older-fx-observation-skipped",
        severity: "info",
        message: "Kept the fresher incumbent FX observations over an older source payload.",
        metadata: { pegKeys: skippedOlderPegKeys, sourceUpdatedAt },
      });
    }
  }

  private applyPerUsdPayload<TPayload>(input: ApplyPerUsdPayloadInput<TPayload>): void {
    const {
      payload,
      mappings,
      includeMissingPrevious,
      cadence,
      source,
      resolveSourceMeta,
      getPerUsd,
    } = input;
    const { sourceUpdatedAt, sourceDate } = resolveSourceMeta(payload);

    this.applyInverseRateMappings({
      mappings,
      includeMissingPrevious,
      sourceUpdatedAt,
      sourceDate,
      cadence,
      source,
      getPerUsd: (currency) => getPerUsd(payload, currency),
    });
  }

  applySecondaryRates(
    candidate: SecondaryCurrencyCandidate,
    mappings: SecondaryFxMappings,
    options: { includeMissingPrevious?: boolean } = {},
  ): void {
    if (candidate.payload.date != null && !isAdmissibleFxSourceDate(candidate.payload.date, this.syncStartSec)) return;
    this.applyPerUsdPayload({
      payload: candidate,
      mappings,
      includeMissingPrevious: options.includeMissingPrevious,
      cadence: "calendar-daily",
      source: "fawazahmed0",
      resolveSourceMeta: ({ payload }) => {
        const sourceDate = typeof payload.date === "string" && payload.date.length > 0
          ? payload.date
          : null;
        return {
          sourceUpdatedAt: resolveDatedSourceUpdatedAt(sourceDate, this.syncStartSec),
          sourceDate,
        };
      },
      getPerUsd: ({ payload }, currency) => payload.usd?.[currency.toLowerCase()],
    });
  }

  applyExchangeRateApiRates(
    payload: ExchangeRateApiPayload,
    mappings: SecondaryFxMappings,
    options: { includeMissingPrevious?: boolean } = {},
  ): void {
    const timestamp = payload.time_last_update_unix;
    if (timestamp != null && (
      !Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > this.syncStartSec
    )) return;
    this.applyPerUsdPayload({
      payload,
      mappings,
      includeMissingPrevious: options.includeMissingPrevious,
      cadence: "calendar-daily",
      source: "exchangeRateApi",
      resolveSourceMeta: () => {
        const sourceUpdatedAt = timestamp == null ? null : Math.floor(timestamp);
        return {
          sourceUpdatedAt,
          sourceDate: sourceUpdatedAt == null
            ? null
            : new Date(sourceUpdatedAt * 1000).toISOString().slice(0, 10),
        };
      },
      getPerUsd: (sourcePayload, currency) => sourcePayload.rates[currency.toUpperCase()],
    });
  }

  async tryLiveFullSetFallback(
    frankfurterSource: "error" | "invalid-payload",
    loaders: {
      loadSecondaryCurrencyCandidate: () => Promise<SecondaryCurrencyCandidate | null>;
      loadExchangeRateApiPayload: () => Promise<ExchangeRateApiPayload | null>;
      primaryMappings: SecondaryFxMappings;
      secondaryMappings: SecondaryFxMappings;
    },
  ): Promise<"full" | "partial" | "unavailable"> {
    const secondaryCandidate = await loaders.loadSecondaryCurrencyCandidate();
    if (secondaryCandidate) {
      this.usableRates = {};
      this.applySecondaryRates(secondaryCandidate, loaders.primaryMappings);
      this.applySecondaryRates(secondaryCandidate, loaders.secondaryMappings);
      const fullCoverage = this.expectedPegKeys.every((pegKey) => pegKey in this.usableRates);
      const hasProvenance = this.expectedPegKeys.every(
        (pegKey) => this.sourceUpdatedAtByPeg[pegKey] != null,
      );
      this.fallbackMode = "secondary-live-fallback";
      this.sources = {
        ...this.sources,
        frankfurter: frankfurterSource,
        fawazahmed0: fullCoverage && hasProvenance ? "ok" : "partial",
      };
      return fullCoverage ? "full" : "partial";
    }

    const exchangeRateApiPayload = await loaders.loadExchangeRateApiPayload();
    if (exchangeRateApiPayload) {
      this.usableRates = {};
      this.applyExchangeRateApiRates(exchangeRateApiPayload, loaders.primaryMappings);
      this.applyExchangeRateApiRates(exchangeRateApiPayload, loaders.secondaryMappings);
      const fullCoverage = this.expectedPegKeys.every((pegKey) => pegKey in this.usableRates);
      const hasProvenance = this.expectedPegKeys.every(
        (pegKey) => this.sourceUpdatedAtByPeg[pegKey] != null,
      );
      this.fallbackMode = "exchange-rate-api-live-fallback";
      this.sources = {
        ...this.sources,
        frankfurter: frankfurterSource,
        fawazahmed0: "error",
        exchangeRateApi: fullCoverage && hasProvenance ? "ok" : "partial",
      };
      return fullCoverage ? "full" : "partial";
    }

    this.sources = {
      ...this.sources,
      frankfurter: frankfurterSource,
      fawazahmed0: "error",
    };
    if (this.canCarryForwardPreviousRates()) {
      this.usableRates = { ...this.prevRates };
      Object.keys(this.usableRates).forEach((pegKey) => this.inheritPrevious(pegKey));
      this.fallbackMode = "cadence-valid-carry-forward";
      this.sources = {
        ...this.sources,
        cache: "carry-forward",
      };
      return "full";
    }
    return "unavailable";
  }

  applyFrankfurterRates(
    rates: Record<string, number>,
    sourceDate: string,
    currencyToPeg: Record<string, string>,
  ): void {
    const clocks = getEcbFixingClocks(sourceDate, this.syncStartSec);
    if (clocks == null) return;
    this.ecbDate = sourceDate;

    const release = assessEcbRelease(Date.parse(`${sourceDate}T00:00:00Z`) / 1000, this.syncStartSec);
    if (release.missedPublishes > 0) {
      this.recordCronEvent({
        eventType: "ecb-rates-stale",
        severity: "warning",
        message: "ECB rates are behind the expected TARGET release.",
        metadata: { sourceDate, ...release },
      });
    }

    const mappings = Object.entries(currencyToPeg);
    this.applyInverseRateMappings({
      mappings, sourceUpdatedAt: clocks.observedAtSec, publishedAtSec: clocks.publishedAtSec,
      sourceDate, cadence: "business-daily", source: "frankfurter", getPerUsd: (currency) => rates[currency],
    });
    for (const [currency, pegKey] of mappings) {
      if (!(pegKey in this.usableRates)) this.ensureCachedRate(pegKey, currency, { requireCadenceValid: true });
    }
  }

  /**
   * Overlays one validated OXR snapshot. Every applied rate carries the snapshot's
   * upstream `observedAt`, never this run's clock, so a later Chainlink comparison
   * sees the real observation age.
   */
  applyRealtimeOverlayRates(observation: RealtimeFxObservation): number {
    let applied = 0;
    for (const pegKey of observation.rates.keys()) this.offeredPegKeys.add(pegKey);
    if (getRealtimeFxTimestampRejection(observation.observedAt, this.syncStartSec)) return applied;
    const fxSession = getReferenceSessionState("fx", this.syncStartSec);
    for (const [pegKey, realtimeRate] of observation.rates) {
      const keepIncumbent = this.preferIncumbent(pegKey, observation.observedAt, "intraday", true);
      const baseline = this.baselines[pegKey];
      const currentRate = this.usableRates[pegKey];
      if (currentRate == null && !baseline) {
        if (this.validateRate(pegKey, realtimeRate, undefined)) {
          this.provisionalRealtimeOverlayPegs.add(pegKey);
          this.recordCronEvent({
            eventType: "realtime-rate-provisional",
            severity: "warning",
            message: "Realtime FX rate lacked current or previous reference.",
            metadata: { pegKey, realtimeRate },
          });
        }
        continue;
      }

      const anchor = currentRate ?? (!this.previousIsFresh(pegKey) ? baseline?.usdPerUnit : undefined);
      const delta = anchor == null ? 0 : Math.abs(realtimeRate - anchor) / anchor;
      const diverged = delta > REALTIME_OVERLAY_MAX_DIVERGENCE;
      const candidate: FxReferenceObservation = {
        pegKey, usdPerUnit: realtimeRate, source: "openExchangeRates", cadence: "intraday",
        observedAtSec: observation.observedAt,
      };
      if (!diverged && this.validateRate(pegKey, realtimeRate, baseline?.usdPerUnit)) {
        if (keepIncumbent) recordFxSourceSample(this.referenceSourceSamples, candidate, isObservationFreshAt);
        else {
          this.selectObservation(candidate);
          applied++;
        }
      } else if (!keepIncumbent && fxSession.open && observation.observedAt >= fxSession.sessionOpenedAtSec
        && !(diverged && this.currentIsFresh(pegKey)) && this.canCorroborate(pegKey, realtimeRate, observation.observedAt)) {
        this.regimeCandidates[pegKey] = candidate;
        this.pendingRegimePegs.add(pegKey);
      } else if (diverged) {
        this.recordCronEvent({
          eventType: "realtime-rate-diverged",
          severity: "warning",
          message: "Realtime FX rate diverged from current reference.",
          metadata: { pegKey, currentRate: anchor, realtimeRate, deltaPct: Number((delta * 100).toFixed(1)) },
        });
      }
    }

    return applied;
  }

  applyChainlinkQuotes(quotes: Map<string, ChainlinkReferenceQuote>): number {
    let accepted = 0;

    for (const [pegKey, quote] of quotes) {
      this.offeredPegKeys.add(pegKey);
      if (quote.updatedAt > this.syncStartSec) continue;
      const normalized = Number(quote.price.toFixed(6));
      const candidate: FxReferenceObservation = {
        pegKey, usdPerUnit: normalized, observedAtSec: quote.updatedAt, source: "chainlink", cadence: "intraday",
      };
      const existingUpdatedAt = this.sourceUpdatedAtByPeg[pegKey] ?? null;
      const quoteOlderThanCurrent =
        existingUpdatedAt != null &&
        Number.isFinite(existingUpdatedAt) &&
        existingUpdatedAt > 0 &&
        quote.updatedAt < existingUpdatedAt;
      const metalPegKey = isChainlinkMetalPegKey(pegKey);
      // One incumbent-authority predicate for the spot and Chainlink paths
      // (R5): an unknown clock is not fresh, so it gets no veto. Non-metal
      // overlays retain their existing divergence guard.
      const incumbentIsFresh = metalPegKey
        ? isFreshFxObservation(existingUpdatedAt, this.sourceModeByPeg[pegKey], this.syncStartSec, {
          pegKey,
          cadence: this.sourceCadenceByPeg[pegKey],
          sourceDate: this.sourceDateByPeg[pegKey] ?? null,
        })
        : true;
      const existing = this.usableRates[pegKey];
      const hasExisting = existing != null && existing > 0;
      const divergenceReference = hasExisting ? existing : metalPegKey ? undefined : this.baselines[pegKey]?.usdPerUnit;

      if (quoteOlderThanCurrent && metalPegKey) {
        // A metal clock never moves backwards: an older round may confirm a
        // fresh incumbent within the cross-check bound, but it can never
        // replace it.
        if (hasExisting && incumbentIsFresh) {
          const delta = Math.abs(quote.price - existing) / existing;
          if (delta > CHAINLINK_REFERENCE_MAX_DIVERGENCE) {
            this.recordCronEvent({
              eventType: "chainlink-rate-diverged",
              severity: "warning",
              message: "Chainlink quote diverged from current reference.",
              metadata: {
                pegKey,
                currentRate: existing,
                chainlinkRate: quote.price,
                deltaPct: Number((delta * 100).toFixed(1)),
              },
            });
          } else if (this.validateRate(pegKey, normalized, undefined)) {
            if (isObservationFreshAt(candidate, this.syncStartSec)) {
              recordFxSourceSample(this.referenceSourceSamples, candidate, isObservationFreshAt);
            }
            this.recordCronEvent({
              eventType: "chainlink-older-metal-quote-validated",
              severity: "info",
              message: "Validated older Chainlink metal quote against current reference.",
              metadata: {
                pegKey,
                currentRate: existing,
                chainlinkRate: Number(quote.price.toFixed(6)),
                chainlinkUpdatedAt: quote.updatedAt,
                existingUpdatedAt,
              },
            });
            accepted++;
          }
        } else {
          this.recordCronEvent({
            eventType: "chainlink-older-quote-skipped",
            severity: "info",
            message: "Skipping older Chainlink metal quote against a non-fresh incumbent.",
            metadata: { pegKey, chainlinkUpdatedAt: quote.updatedAt, existingUpdatedAt },
          });
        }
        continue;
      }

      if (divergenceReference != null && incumbentIsFresh) {
        const delta = Math.abs(quote.price - divergenceReference) / divergenceReference;
        if (delta > CHAINLINK_REFERENCE_MAX_DIVERGENCE) {
          this.recordCronEvent({
            eventType: "chainlink-rate-diverged",
            severity: "warning",
            message: "Chainlink quote diverged from current reference.",
            metadata: {
              pegKey,
              currentRate: divergenceReference,
              chainlinkRate: quote.price,
              deltaPct: Number((delta * 100).toFixed(1)),
            },
          });
          continue;
        }
      } else if (hasExisting && metalPegKey) {
        // A stale or unknown-clock incumbent has no 5% veto, but a move past
        // the prior-value delta bound needs an independent fresh corroborator.
        // The run's metal resolution would already have applied one, so no
        // such corroboration remains here.
        const delta = Math.abs(quote.price - existing) / existing;
        if (delta > MAX_FX_RATE_DELTA_PCT) {
          this.recordCronEvent({
            eventType: "chainlink-rate-diverged",
            severity: "warning",
            message: "Chainlink quote jumped a non-fresh reference without fresh corroboration.",
            metadata: {
              pegKey,
              currentRate: existing,
              chainlinkRate: quote.price,
              deltaPct: Number((delta * 100).toFixed(1)),
            },
          });
          continue;
        }
      }

      const prevRateForValidation = metalPegKey
        ? (hasExisting && !incumbentIsFresh ? undefined : this.prevRates[pegKey])
        : this.baselines[pegKey]?.usdPerUnit;
      if (this.validateRate(pegKey, normalized, prevRateForValidation)) {
        const fresh = isObservationFreshAt(candidate, this.syncStartSec);
        if (quoteOlderThanCurrent || this.preferIncumbent(pegKey, quote.updatedAt, "intraday", fresh)) {
          if (fresh) recordFxSourceSample(this.referenceSourceSamples, candidate, isObservationFreshAt);
          this.recordCronEvent({
            eventType: "chainlink-older-quote-skipped",
            severity: "info",
            message: "Kept the incumbent FX reference over a Chainlink quote.",
            metadata: { pegKey, chainlinkUpdatedAt: quote.updatedAt, existingUpdatedAt },
          });
          continue;
        }
        this.selectObservation(candidate);
        accepted++;
      } else if (!(pegKey in this.usableRates) && this.prevRates[pegKey]) {
        // A rejected quote never displaces an incumbent from this run; only a
        // peg with no current value may recover its previous observation.
        this.usableRates[pegKey] = this.prevRates[pegKey]!;
        this.inheritPrevious(pegKey);
      }
    }

    return accepted;
  }

  ensureCachedRate(
    pegKey: string,
    label: string,
    options: { requireCadenceValid?: boolean } = {},
  ): boolean {
    if (pegKey in this.usableRates || typeof this.prevRates[pegKey] !== "number" || this.prevRates[pegKey] <= 0) {
      return false;
    }
    if (options.requireCadenceValid && this.previousSourceStatus(pegKey) !== "fresh") {
      return false;
    }

    this.usableRates[pegKey] = this.prevRates[pegKey]!;
    this.inheritPrevious(pegKey);
    this.recordCronEvent({
      eventType: "cached-rate-used",
      severity: "info",
      message: "Using cached FX rate.",
      metadata: { pegKey, label, rate: this.usableRates[pegKey] },
    });
    return true;
  }

  ensureCadenceValidRate(pegKey: string, label: string): boolean {
    const currentRate = this.usableRates[pegKey];
    if (typeof currentRate === "number" && currentRate > 0 && this.currentSourceStatus(pegKey) === "fresh") {
      return true;
    }

    this.clearRate(pegKey);
    return this.ensureCachedRate(pegKey, label, { requireCadenceValid: true });
  }

  private clearRate(pegKey: string): void {
    delete this.usableRates[pegKey];
    delete this.sourceUpdatedAtByPeg[pegKey];
    delete this.sourceModeByPeg[pegKey];
    delete this.sourceCadenceByPeg[pegKey];
    delete this.sourceDateByPeg[pegKey];
    this.legacyDetectionPegs.delete(pegKey);
    delete this.observations[pegKey];
    delete this.referenceMedianContributorsByPeg[pegKey];
  }

  applyResolvedMetals(metals: MetalsResolution): void {
    for (const pegKey of ["peggedGOLD", "peggedSILVER"] as const) {
      const resolved = metals.resolvedByPeg[pegKey];
      if (!resolved) continue;
      if (resolved.source !== "cached") this.offeredPegKeys.add(pegKey);
      const { updatedAt } = resolved;
      if (updatedAt != null && updatedAt > this.syncStartSec) continue;
      const source = resolved.source === "commodity-peer-median" ? "peer-median" : resolved.source;
      const isFresh = updatedAt != null && this.syncStartSec - updatedAt <= REFERENCE_INTRADAY_BUDGET_SEC;
      if (this.preferIncumbent(pegKey, updatedAt, "intraday", isFresh)) {
        if (source !== "cached" && updatedAt != null) {
          recordFxSourceSample(this.referenceSourceSamples, {
            pegKey, usdPerUnit: resolved.rate, observedAtSec: updatedAt, source, cadence: "intraday",
          }, isObservationFreshAt);
        }
        continue;
      }

      this.usableRates[pegKey] = resolved.rate;
      if (source === "cached") {
        this.inheritPrevious(pegKey);
      } else {
        this.markLive(pegKey, updatedAt, "intraday", null, source);
        if (this.observations[pegKey]?.source === "peer-median" && resolved.contributors) {
          this.referenceMedianContributorsByPeg[pegKey] = resolved.contributors;
        }
      }
    }
  }

  /**
   * Seed cached rates from the previous state and transition the run into
   * cached-fallback mode, keeping `mode`, `fallbackMode`, and `sources` in sync
   * so callers can't set one without the others.
   */
  enterCachedFallback(frankfurterStatus: string): void {
    this.seedCachedFallbackFromPrevious();
    this.mode = "cached-fallback";
    this.fallbackMode = "cached-fx-rates";
    this.sources = {
      ...this.sources,
      frankfurter: frankfurterStatus,
      cache: "ok",
    };
  }

  maybeRecoverFromCachedFallback(): void {
    if (this.mode !== "cached-fallback" || !this.hasFreshFullFxCoverage()) return;

    this.mode = "live";
    this.fallbackMode = "independent-live-recovery";
    if (this.sources.cache === "ok") {
      this.sources.cache = "recovered";
    }
    this.recordCronEvent({
      eventType: "cached-fallback-recovered",
      severity: "info",
      message: "Independent FX sources restored fresh full-set coverage after cached fallback.",
    });
  }

  getMissingPegKeys(): string[] {
    return this.expectedPegKeys.filter((pegKey) => !(pegKey in this.usableRates));
  }

  buildPersistedMeta(): FxRatesMeta {
    const prior = this.prevState?.metadataIdentity === "verified" ? this.prevState : null;
    const omittedCloseCarryPegs = new Set<string>();
    // Preserve eligibility through consecutive omissions. Any offered replacement ends the omission.
    for (const { observation } of Object.values(this.referenceSourceSamples)) {
      const { pegKey, source } = observation;
      if (source !== "peer-median" && !(pegKey in this.usableRates) && !this.offeredPegKeys.has(pegKey) &&
        (prior?.selectedReferenceEvidence?.[pegKey] || prior?.omittedCloseCarryPegs?.includes(pegKey))) {
        omittedCloseCarryPegs.add(pegKey);
      }
    }
    const directMetalReferences: NonNullable<FxRatesMeta["directMetalReferences"]> = {};
    for (const pegKey of ["peggedGOLD", "peggedSILVER"] as const) {
      for (const source of ["gold-api.com", "chainlink"] as const) {
        const sample = this.referenceSourceSamples[`${pegKey}:${source}`];
        if (!sample || sample.observation.observedAtSec <= (directMetalReferences[pegKey]?.observation.observedAtSec ?? 0)) continue;
        const { observation, evidence } = sample;
        const admitAt = (decisionAtSec: number) => evaluateReferenceAdmission({
          kind: "fallback", observation, ...evidence, decisionAtSec,
          quoteObservedAtSec: observation.observedAtSec, rawDeviationBps: null,
        });
        let verdict = admitAt(this.syncStartSec);
        // While the metal market is closed, keep the session's last live benchmark for Safety capacity sizing.
        if (verdict.status === "held-closed-session" &&
          heldCloseBenchmarkExtensionSec("metal", observation.observedAtSec, this.syncStartSec) !== null) {
          verdict = admitAt(observation.observedAtSec);
        }
        if (verdict.reason === "live-reference" && evidence.sessionOpenedAtSec === verdict.sessionOpenedAtSec) {
          directMetalReferences[pegKey] = {
            observation, generation: `fx:${this.syncStartSec}`,
            firstInSessionObservedAtSec: evidence.firstInSessionObservedAtSec, preCloseUsdPerUnit: evidence.preCloseUsdPerUnit,
          };
        }
      }
    }
    const lastAcceptedBaselines = { ...this.baselines };
    for (const [pegKey, usdPerUnit] of Object.entries(this.usableRates)) {
      const baseline = lastAcceptedBaselines[pegKey];
      const observedAtSec = this.sourceUpdatedAtByPeg[pegKey] ?? null;
      if (!baseline || (observedAtSec != null && observedAtSec >= (baseline.observedAtSec ?? 0))) {
        lastAcceptedBaselines[pegKey] = { usdPerUnit, observedAtSec };
      }
    }
    return {
      usableSyncAt: this.syncStartSec,
      mode: this.mode,
      sourceUpdatedAtByPeg: this.sourceUpdatedAtByPeg,
      sourceModeByPeg: this.sourceModeByPeg,
      sourceCadenceByPeg: this.sourceCadenceByPeg,
      sourceDateByPeg: this.sourceDateByPeg,
      // A wholly carried main-format generation still has no evidence. An explicit empty map means evidence was withheld.
      observations: this.legacyDetectionPegs.size > 0 && Object.keys(this.observations).length === 0 &&
        Object.keys(this.usableRates).every((peg) => this.legacyDetectionPegs.has(peg)) ? undefined : this.observations,
      ...(this.legacyDetectionPegs.size ? { legacyDetectionPegs: [...this.legacyDetectionPegs] } : {}),
      ...(omittedCloseCarryPegs.size ? { omittedCloseCarryPegs: [...omittedCloseCarryPegs] } : {}),
      directMetalReferences,
      referenceMedianContributorsByPeg: this.referenceMedianContributorsByPeg,
      dailyObservations: this.dailyObservations,
      lastAcceptedBaselines,
      referenceSourceSamples: this.referenceSourceSamples,
      previousRegimeByPeg: this.previousRegimeByPeg,
      sources: this.sources,
      ecbDate: this.ecbDate,
      previousCacheUpdatedAt: this.prevState?.usableSyncAt ?? null,
      consecutiveFallbackRuns:
        this.mode === "cached-fallback"
          ? this.prevState?.mode === "cached-fallback"
            ? this.prevState.consecutiveFallbackRuns + 1
            : 1
          : 0,
    };
  }

  buildResultMetadata(secondaryPegKeys: string[]): Record<string, unknown> {
    const missing = this.getMissingPegKeys();
    const meta = this.buildPersistedMeta();
    const provisionalRealtimeOverlayPegs = [...this.provisionalRealtimeOverlayPegs];
    return {
      rateCount: Object.keys(this.usableRates).length,
      mode: this.mode,
      fallbackMode: this.fallbackMode,
      missing: missing.length > 0 ? missing : undefined,
      provisionalRealtimeOverlayPegs: provisionalRealtimeOverlayPegs.length > 0
        ? provisionalRealtimeOverlayPegs
        : undefined,
      validationIssues: this.validationIssues,
      pendingRegimePegs: this.pendingRegimePegs.size > 0 ? [...this.pendingRegimePegs] : undefined,
      secondaryCoverage: secondaryPegKeys.filter((pegKey) => pegKey in this.usableRates).length,
      ecbDate: this.ecbDate ?? undefined,
      consecutiveFallbackRuns: meta.consecutiveFallbackRuns,
      sources: this.sources,
    };
  }
}

export async function runOpenExchangeRatesOverlay(
  db: D1Database,
  state: FxSyncRunState,
  openExchangeRatesKey: string | undefined,
  signal: AbortSignal | undefined,
  runBestEffort: RunBestEffort,
): Promise<OpenExchangeRatesSourceStatus> {
  if (!openExchangeRatesKey) {
    return "unavailable";
  }
  if (!getReferenceSessionState("fx", state.syncStartSec).open) return "skipped";
  const attemptedAt = state.syncStartSec;
  const hourStart = Math.floor(attemptedAt / OXR_POLL_INTERVAL_SEC) * OXR_POLL_INTERVAL_SEC;
  const reservationFailed = async (operation: "read" | "write" | "release", error: unknown): Promise<"unavailable"> => {
    if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
    await logCronEvent(db, {
      job: "sync-fx-rates",
      eventType: "openexchange-rates-reservation-failed",
      severity: "warning",
      message: "Open Exchange Rates hour reservation storage operation failed.",
      metadata: { operation, hourStart, error: toErrorMessage(error) },
    });
    return "unavailable";
  };
  try {
    const lastAttemptAt = await getCacheUpdatedAt(db, OXR_LAST_ATTEMPT_KEY);
    if (lastAttemptAt != null && lastAttemptAt >= hourStart) return "skipped";
  } catch (error) {
    return reservationFailed("read", error);
  }

  // Keep the epoch prefix readable by the pre-lane rollback code.
  const reservationOwner = `${attemptedAt}:${crypto.randomUUID()}`;
  try {
    const attempt = await db.prepare(`
      INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      WHERE cache.updated_at < ?
    `).bind(OXR_LAST_ATTEMPT_KEY, reservationOwner, attemptedAt, hourStart).run();
    if (!attempt.meta.changes) return "skipped";
  } catch (error) {
    return reservationFailed("write", error);
  }

  let requestStarted = false;
  const overlay = withFxOverlayCircuit(db, {
    source: CIRCUIT_SOURCE.FX_REALTIME,
    circuitOpenEvent: {
      eventType: "openexchange-rates-circuit-open",
      severity: "warning",
      message: "Open Exchange Rates realtime circuit is open; skipping overlay.",
    },
    failedEvent: {
      eventType: "openexchange-rates-fetch-failed",
      severity: "warning",
      message: "Open Exchange Rates realtime fetch failed.",
    },
    failureOutcomeLabel: "recordOutcome:fx-realtime-failure",
    signal,
    runBestEffort,
    run: async () => {
      signal?.throwIfAborted();
      requestStarted = true;
      const realtimeFetch = await fetchRealtimeFxRates(openExchangeRatesKey, signal, attemptedAt);
      if (realtimeFetch.statusCode === 429 || realtimeFetch.statusCode === 403) {
        await logCronEvent(db, {
          job: "sync-fx-rates",
          eventType: "openexchange-rates-quota-limited",
          severity: "error",
          message: "Open Exchange Rates restricted API access. Check the quota and other users of the key.",
          metadata: { statusCode: realtimeFetch.statusCode, attemptedAt },
        });
        await runBestEffort("recordOutcome:fx-realtime-rate-limit", async () => {
          await recordOutcome(db, CIRCUIT_SOURCE.FX_REALTIME, false);
        });
        return "rate-limited";
      }

      if (realtimeFetch.rejection) {
        await logCronEvent(db, {
          job: "sync-fx-rates",
          eventType: "openexchange-rates-observation-rejected",
          severity: "warning",
          message: "Rejected Open Exchange Rates snapshot because its upstream timestamp is not admissible.",
          metadata: {
            reason: realtimeFetch.rejection.reason,
            upstreamTimestamp: realtimeFetch.rejection.upstreamTimestamp,
            attemptedAt,
          },
        });
      }
      const observation = realtimeFetch.observation;
      const availableCount = observation?.rates.size ?? 0;
      const realtimeApplied = observation ? state.applyRealtimeOverlayRates(observation) : 0;
      if (availableCount > 0) {
        await runBestEffort("fx-oxr-last-success-write", async () => {
          await setCache(db, OXR_LAST_SUCCESS_KEY, String(attemptedAt));
        });
      }

      await logCronEvent(db, {
        job: "sync-fx-rates",
        eventType: "openexchange-rates-applied",
        severity: realtimeApplied === availableCount ? "info" : "warning",
        message: "Applied realtime FX overlay rates.",
        metadata: { applied: realtimeApplied, available: availableCount, observedAt: observation?.observedAt ?? null },
      });
      await runBestEffort("recordOutcome:fx-realtime", async () => {
        await recordOutcome(db, CIRCUIT_SOURCE.FX_REALTIME, availableCount > 0);
      });
      return availableCount > 0
        ? (realtimeApplied === availableCount ? "ok" : "partial")
        : "unavailable";
    },
  });
  return overlay.finally(async () => {
    if (requestStarted) return;
    try {
      await db.prepare("DELETE FROM cache WHERE key = ? AND value = ? AND updated_at = ?")
        .bind(OXR_LAST_ATTEMPT_KEY, reservationOwner, attemptedAt).run();
    } catch (error) {
      await reservationFailed("release", error);
    }
  });
}

async function applyChainlinkOverlaySnapshot(
  db: D1Database,
  state: FxSyncRunState,
  snapshot: ChainlinkReferenceQuoteSnapshot,
  runBestEffort: RunBestEffort,
): Promise<ChainlinkSourceStatus> {
  const accepted = state.applyChainlinkQuotes(snapshot.quotes);
  const outcomes = Object.values(snapshot.perFeedOutcomes);
  const hasReadableRound = outcomes.some((outcome) => outcome !== "failure");
  if (Object.keys(snapshot.outOfBudgetRounds).length > 0) {
    await logCronEvent(db, {
      job: "sync-fx-rates",
      eventType: "chainlink-reference-out-of-budget",
      severity: "info",
      message: "Readable Chainlink rounds exceeded their pricing age limits.",
      metadata: { rounds: snapshot.outOfBudgetRounds, generation: state.syncStartSec },
    });
  }
  await runBestEffort("recordOutcome:chainlink-feeds", async () => {
    await recordOutcome(db, CIRCUIT_SOURCE.CHAINLINK_FEEDS, hasReadableRound);
  });
  if (!hasReadableRound) return "unavailable";
  if (outcomes.every((outcome) => outcome === "out-of-budget")) return "out-of-budget";
  return accepted === snapshot.summary.configuredFeeds ? "ok" : "partial";
}

/**
 * Fetch the Chainlink reference snapshot before metals resolution so a fresh
 * metal round can corroborate a spot move that exceeds the prior-value delta
 * bound against a non-fresh incumbent. The caller must pass the result to
 * `runChainlinkOverlay` so one fetch serves both purposes.
 */
export async function prepareChainlinkOverlay(
  db: D1Database,
  state: FxSyncRunState,
  signal: AbortSignal | undefined,
  chainRpcs: Map<string, ChainRpcConfig> | undefined,
  drpcApiKey: string | null | undefined,
  etherscanApiKey: string | null | undefined,
  runBestEffort: RunBestEffort,
): Promise<ChainlinkReferenceQuoteSnapshot | "unavailable"> {
  const snapshot = await withFxOverlayCircuit(db, {
    source: CIRCUIT_SOURCE.CHAINLINK_FEEDS,
    circuitOpenEvent: {
      eventType: "chainlink-reference-feed-circuit-open",
      severity: "warning",
      message: "Chainlink reference-feed circuit is open; skipping overlay.",
    },
    failedEvent: {
      eventType: "chainlink-reference-feeds-failed",
      severity: "warning",
      message: "Chainlink reference feeds failed.",
    },
    failureOutcomeLabel: "recordOutcome:chainlink-feeds-failure",
    signal,
    runBestEffort,
    run: async () => {
      const previousFailingRuns = await loadChainlinkFailingRuns(db);
      return await fetchChainlinkReferenceQuoteSnapshot(
        signal,
        chainRpcs,
        state.syncStartSec,
        drpcApiKey,
        etherscanApiKey,
        previousFailingRuns,
      );
    },
  });
  if (snapshot === "unavailable") return snapshot;
  await runBestEffort("setCache:chainlink-failing-runs", async () => {
    await setCache(db, CHAINLINK_FAILING_RUNS_CACHE_KEY, JSON.stringify(snapshot.failingRuns));
  });
  return snapshot;
}

export async function runChainlinkOverlay(
  db: D1Database,
  state: FxSyncRunState,
  signal: AbortSignal | undefined,
  chainRpcs: Map<string, ChainRpcConfig> | undefined,
  drpcApiKey: string | null | undefined,
  etherscanApiKey: string | null | undefined,
  runBestEffort: RunBestEffort,
  prepared?: ChainlinkReferenceQuoteSnapshot | "unavailable",
): Promise<ChainlinkSourceStatus> {
  if (prepared === "unavailable") return "unavailable";
  if (prepared) return applyChainlinkOverlaySnapshot(db, state, prepared, runBestEffort);
  return withFxOverlayCircuit(db, {
    source: CIRCUIT_SOURCE.CHAINLINK_FEEDS,
    circuitOpenEvent: {
      eventType: "chainlink-reference-feed-circuit-open",
      severity: "warning",
      message: "Chainlink reference-feed circuit is open; skipping overlay.",
    },
    failedEvent: {
      eventType: "chainlink-reference-feeds-failed",
      severity: "warning",
      message: "Chainlink reference feeds failed.",
    },
    failureOutcomeLabel: "recordOutcome:chainlink-feeds-failure",
    signal,
    runBestEffort,
    run: async () => {
      const previousFailingRuns = await loadChainlinkFailingRuns(db);
      const snapshot = await fetchChainlinkReferenceQuoteSnapshot(
        signal,
        chainRpcs,
        state.syncStartSec,
        drpcApiKey,
        etherscanApiKey,
        previousFailingRuns,
      );
      await runBestEffort("setCache:chainlink-failing-runs", async () => {
        await setCache(db, CHAINLINK_FAILING_RUNS_CACHE_KEY, JSON.stringify(snapshot.failingRuns));
      });
      return applyChainlinkOverlaySnapshot(db, state, snapshot, runBestEffort);
    },
  });
}
