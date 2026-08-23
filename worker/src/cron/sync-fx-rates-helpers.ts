import { DAY_SECONDS } from "@shared/lib/time-constants";
import { CIRCUIT_SOURCE } from "../lib/constants";
import { fetchRealtimeFxRates } from "../lib/fx-realtime";
import { fetchChainlinkReferenceQuoteSnapshot, type ChainlinkReferenceQuote } from "../lib/chainlink-feeds";
import type { ChainRpcConfig } from "../lib/chain-registry";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import { getCache, setCache } from "../lib/db-cache";
import type { MetalPegKey, MetalsResolution } from "../lib/fx-metals";
import type { FxRateSourceMode, FxRateState, FxRateSyncMode, FxRatesMeta, FxSourceCadence } from "../lib/fx-rate-state";
import { getFxSourceStatus, persistFxRateState } from "../lib/fx-rate-state";
import { logCronEvent, type CronEventInput, type CronResult } from "../lib/cron-logger";
import {
  applyRealtimeOverlaySourceMetadata,
  canCarryForwardFxRates,
  inheritFxSourceMetadata,
} from "../lib/fx-source-metadata";
import { invertUnitsPerUsd } from "../lib/fx-config";
import { toErrorMessage } from "../lib/error-utils";

const CHAINLINK_FAILING_RUNS_CACHE_KEY = "chainlink:failing-runs";
const CHAINLINK_REFERENCE_MAX_DIVERGENCE = 0.05;
const REALTIME_OVERLAY_MAX_DIVERGENCE = 0.05;
const CHAINLINK_METAL_PEG_KEYS = new Set<string>(["peggedGOLD", "peggedSILVER"]);
const OXR_LAST_ATTEMPT_KEY = "fx-oxr-last-attempt";
const OXR_LAST_SUCCESS_KEY = "fx-oxr-last-success";
// TODO(cleanup): Remove this constant and the fallback read at ~L735 after 2026-09-15.
// Once every live isolate has written OXR_LAST_ATTEMPT_KEY at least once, this legacy key
// is permanently dead. Also delete the 'fx-oxr-last-fetch' row from the cache table via migration.
const OXR_LEGACY_LAST_FETCH_KEY = "fx-oxr-last-fetch";
// Open Exchange Rates free-tier hourly quota: skip fetches within this window of the last attempt.
const OXR_RATE_LIMIT_MINUTES = 55;

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

export type OpenExchangeRatesSourceStatus = "ok" | "partial" | "rate-limited" | "unavailable";
export type ChainlinkSourceStatus = "ok" | "partial" | "unavailable";

async function withFxOverlayCircuit<TStatus extends string>(
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
  const canonicalCache = cacheResult.rates.written ? null : await getCache(db, "fx-rates");
  const lastWriteAdvanced = cacheResult.rates.written || (!!canonicalCache && canonicalCache.updatedAt > syncStartSec);
  await state.flushCronEvents(db);
  await logCronEvent(db, {
    job: "sync-fx-rates",
    eventType: cacheResult.rates.written ? "fx-rates-cache-published" : "fx-rates-cache-write-skipped",
    severity: "info",
    message: cacheResult.rates.written
      ? "Cached FX rates."
      : "Cache write skipped because a newer FX rates row exists.",
    metadata: {
      rates: state.usableRates,
      cacheWriteMode: cacheResult.rates.written ? "published" : "skipped-newer",
      syncStartSec,
    },
  });
  return {
    status: state.mode === "cached-fallback" && meta.consecutiveFallbackRuns >= 4 ? "degraded" : undefined,
    itemCount: cacheResult.rates.written ? Object.keys(state.usableRates).length : 0,
    metadata: JSON.stringify({
      ...state.buildResultMetadata(secondaryPegKeys),
      cacheWriteMode: cacheResult.rates.written ? "published" : "skipped-newer",
      casSkipped: cacheResult.rates.skippedBecauseNewer || cacheResult.meta.skippedBecauseNewer,
      cacheKey: "fx-rates",
      syncStartSec,
      cacheWriteSucceeded: cacheResult.rates.written,
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
  sourceUpdatedAt: number;
  sourceDate: string | null;
  cadence: FxSourceCadence;
  getPerUsd(currency: string): number | undefined;
}

interface ApplyPerUsdPayloadInput<TPayload> {
  payload: TPayload;
  mappings: SecondaryFxMappings;
  includeMissingPrevious?: boolean;
  cadence: FxSourceCadence;
  resolveSourceMeta(payload: TPayload): {
    sourceUpdatedAt: number;
    sourceDate: string | null;
  };
  getPerUsd(payload: TPayload, currency: string): number | undefined;
}

function resolveDatedSourceUpdatedAt(
  dateText: string | null | undefined,
  syncStartSec: number,
  publishedHourUtc?: number,
): number {
  if (!dateText) return syncStartSec;
  const timeSuffix = publishedHourUtc == null
    ? "T23:59:59Z"
    : `T${String(publishedHourUtc).padStart(2, "0")}:00:00Z`;
  const parsed = Date.parse(`${dateText}${timeSuffix}`);
  if (!Number.isFinite(parsed)) return syncStartSec;
  return Math.min(syncStartSec, Math.floor(parsed / 1000));
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
  private readonly provisionalRealtimeOverlayPegs = new Set<string>();

  usableRates: Record<string, number> = {};
  mode: FxRateSyncMode = "live";
  ecbDate: string | null = null;
  fallbackMode: string | undefined;
  validationIssues: string | undefined;
  sources: Record<string, string>;

  constructor(params: FxSyncRunStateParams) {
    this.prevState = params.prevState;
    this.prevRates = params.prevState?.rates ?? {};
    this.syncStartSec = params.syncStartSec;
    this.expectedPegKeys = [...params.expectedPegKeys];
    this.validateRate = params.validateRate;
    this.sources = { ...params.initialSources };
  }

  private recordCronEvent(event: FxCronEvent): void {
    this.cronEvents.push(event);
  }

  async flushCronEvents(db: D1Database): Promise<void> {
    const events = this.cronEvents.splice(0);
    for (const event of events) {
      await logCronEvent(db, { job: "sync-fx-rates", ...event });
    }
  }

  markLive(
    pegKey: string,
    updatedAt: number,
    cadence: FxSourceCadence = "intraday",
    sourceDate: string | null = null,
  ): void {
    this.sourceUpdatedAtByPeg[pegKey] = updatedAt;
    this.sourceModeByPeg[pegKey] = "live";
    this.sourceCadenceByPeg[pegKey] = cadence;
    this.sourceDateByPeg[pegKey] = sourceDate;
  }

  inheritPrevious(pegKey: string): void {
    inheritFxSourceMetadata(
      this.prevState,
      pegKey,
      this.sourceUpdatedAtByPeg,
      this.sourceModeByPeg,
      this.sourceCadenceByPeg,
      this.sourceDateByPeg,
    );
  }

  canCarryForwardPreviousRates(): boolean {
    return canCarryForwardFxRates(
      this.expectedPegKeys,
      this.prevState,
      this.prevRates,
      this.syncStartSec,
    );
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
    this.usableRates = { ...this.prevRates };
    Object.keys(this.usableRates).forEach((pegKey) => this.inheritPrevious(pegKey));
    this.ecbDate = this.prevState?.ecbDate ?? null;
  }

  private applyInverseRateMappings(input: ApplyInverseRateMappingsInput): void {
    const {
      mappings,
      includeMissingPrevious = false,
      sourceUpdatedAt,
      sourceDate,
      cadence,
      getPerUsd,
    } = input;

    for (const [currency, pegKey] of mappings) {
      const perUsd = getPerUsd(currency);
      if (typeof perUsd === "number" && Number.isFinite(perUsd) && perUsd > 0) {
        const rate = invertUnitsPerUsd(perUsd);
        if (this.validateRate(pegKey, rate, this.prevRates[pegKey])) {
          this.usableRates[pegKey] = rate;
          this.markLive(pegKey, sourceUpdatedAt, cadence, sourceDate);
        } else if (this.prevRates[pegKey]) {
          this.usableRates[pegKey] = this.prevRates[pegKey]!;
          this.inheritPrevious(pegKey);
        }
      } else if (includeMissingPrevious && this.prevRates[pegKey]) {
        this.usableRates[pegKey] = this.prevRates[pegKey]!;
        this.inheritPrevious(pegKey);
      }
    }
  }

  private applyPerUsdPayload<TPayload>(input: ApplyPerUsdPayloadInput<TPayload>): void {
    const {
      payload,
      mappings,
      includeMissingPrevious,
      cadence,
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
      getPerUsd: (currency) => getPerUsd(payload, currency),
    });
  }

  applySecondaryRates(
    candidate: SecondaryCurrencyCandidate,
    mappings: SecondaryFxMappings,
    options: { includeMissingPrevious?: boolean } = {},
  ): void {
    this.applyPerUsdPayload({
      payload: candidate,
      mappings,
      includeMissingPrevious: options.includeMissingPrevious,
      cadence: "calendar-daily",
      resolveSourceMeta: ({ payload }) => {
        const sourceDate = typeof payload.date === "string" && payload.date.length > 0
          ? payload.date
          : null;
        return {
          sourceUpdatedAt: sourceDate
            ? resolveDatedSourceUpdatedAt(sourceDate, this.syncStartSec)
            : this.syncStartSec,
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
    this.applyPerUsdPayload({
      payload,
      mappings,
      includeMissingPrevious: options.includeMissingPrevious,
      cadence: "calendar-daily",
      resolveSourceMeta: (sourcePayload) => {
        const sourceUpdatedAt =
          typeof sourcePayload.time_last_update_unix === "number" &&
          Number.isFinite(sourcePayload.time_last_update_unix) &&
          sourcePayload.time_last_update_unix > 0
            ? Math.min(this.syncStartSec, Math.floor(sourcePayload.time_last_update_unix))
            : this.syncStartSec;
        return {
          sourceUpdatedAt,
          sourceDate: new Date(sourceUpdatedAt * 1000).toISOString().slice(0, 10),
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
  ): Promise<boolean> {
    const secondaryCandidate = await loaders.loadSecondaryCurrencyCandidate();
    if (secondaryCandidate) {
      this.usableRates = {};
      this.applySecondaryRates(
        secondaryCandidate,
        loaders.primaryMappings,
        { includeMissingPrevious: true },
      );
      // includeMissingPrevious intentionally omitted here: the secondary-live
      // fallback is best-effort, consistent with the Frankfurter happy path
      // (sync-fx-rates.ts also omits it). Only the exchange-rate-api fallback
      // carries forward missing previous values.
      this.applySecondaryRates(secondaryCandidate, loaders.secondaryMappings);
      this.fallbackMode = "secondary-live-fallback";
      this.sources = {
        ...this.sources,
        frankfurter: frankfurterSource,
        fawazahmed0: this.expectedPegKeys.every((pegKey) => pegKey in this.usableRates)
          ? "ok"
          : "partial",
      };
      return true;
    }

    const exchangeRateApiPayload = await loaders.loadExchangeRateApiPayload();
    if (exchangeRateApiPayload) {
      this.usableRates = {};
      this.applyExchangeRateApiRates(
        exchangeRateApiPayload,
        loaders.primaryMappings,
        { includeMissingPrevious: true },
      );
      this.applyExchangeRateApiRates(
        exchangeRateApiPayload,
        loaders.secondaryMappings,
        { includeMissingPrevious: true },
      );
      this.fallbackMode = "exchange-rate-api-live-fallback";
      this.sources = {
        ...this.sources,
        frankfurter: frankfurterSource,
        fawazahmed0: "error",
        exchangeRateApi: this.expectedPegKeys.every((pegKey) => pegKey in this.usableRates)
          ? "ok"
          : "partial",
      };
      return true;
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
      return true;
    }
    return false;
  }

  applyFrankfurterRates(
    rates: Record<string, number>,
    sourceDate: string,
    currencyToPeg: Record<string, string>,
  ): void {
    this.usableRates = {};
    this.ecbDate = sourceDate;

    const ecbDateObj = new Date(`${sourceDate}T16:00:00Z`);
    const ecbUpdatedAt = resolveDatedSourceUpdatedAt(sourceDate, this.syncStartSec, 16);
    const ecbAgeSec = (Date.now() - ecbDateObj.getTime()) / 1000;
    if (ecbAgeSec > DAY_SECONDS) {
      this.recordCronEvent({
        eventType: "ecb-rates-stale",
        severity: "warning",
        message: "ECB rates are stale; non-USD pegs are using last published rates.",
        metadata: { sourceDate, ageHours: Math.round(ecbAgeSec / 3600) },
      });
    }

    for (const [currency, unitsPerUsd] of Object.entries(rates)) {
      const pegKey = currencyToPeg[currency];
      if (!pegKey || !Number.isFinite(unitsPerUsd) || unitsPerUsd <= 0) continue;
      const rate = invertUnitsPerUsd(unitsPerUsd);
      if (this.validateRate(pegKey, rate, this.prevRates[pegKey])) {
        this.usableRates[pegKey] = rate;
        this.markLive(pegKey, ecbUpdatedAt, "business-daily", sourceDate);
      } else if (this.prevRates[pegKey]) {
        this.usableRates[pegKey] = this.prevRates[pegKey]!;
        this.inheritPrevious(pegKey);
      }
    }
  }

  applyRealtimeOverlayRates(rates: Map<string, number>): number {
    let applied = 0;
    const applyRealtimeRate = (pegKey: string, realtimeRate: number) => {
      this.usableRates[pegKey] = realtimeRate;
      applyRealtimeOverlaySourceMetadata(
        pegKey,
        this.syncStartSec,
        this.syncStartSec,
        this.sourceUpdatedAtByPeg,
        this.sourceModeByPeg,
        this.sourceCadenceByPeg,
        this.sourceDateByPeg,
      );
      applied++;
    };

    for (const [pegKey, realtimeRate] of rates) {
      const currentRate = this.usableRates[pegKey];
      if (currentRate != null) {
        const delta = Math.abs(realtimeRate - currentRate) / currentRate;
        if (delta <= REALTIME_OVERLAY_MAX_DIVERGENCE) {
          if (this.validateRate(pegKey, realtimeRate, this.prevRates[pegKey])) {
            applyRealtimeRate(pegKey, realtimeRate);
          }
        } else {
          this.recordCronEvent({
            eventType: "realtime-rate-diverged",
            severity: "warning",
            message: "Realtime FX rate diverged from current reference.",
            metadata: {
              pegKey,
              currentRate,
              realtimeRate,
              deltaPct: Number((delta * 100).toFixed(1)),
            },
          });
        }
      } else {
        const prevRate = this.prevRates[pegKey];
        const hasPreviousRate =
          typeof prevRate === "number" && Number.isFinite(prevRate) && prevRate > 0;
        if (!hasPreviousRate) {
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

        if (this.validateRate(pegKey, realtimeRate, prevRate)) {
          applyRealtimeRate(pegKey, realtimeRate);
        }
      }
    }

    return applied;
  }

  applyChainlinkQuotes(quotes: Map<string, ChainlinkReferenceQuote>): number {
    let accepted = 0;

    for (const [pegKey, quote] of quotes) {
      const existingUpdatedAt = this.sourceUpdatedAtByPeg[pegKey] ?? null;
      const quoteOlderThanCurrent =
        existingUpdatedAt != null &&
        Number.isFinite(existingUpdatedAt) &&
        existingUpdatedAt > 0 &&
        quote.updatedAt < existingUpdatedAt;
      const metalPegKey = isChainlinkMetalPegKey(pegKey);

      if (quoteOlderThanCurrent && !metalPegKey) {
        this.recordCronEvent({
          eventType: "chainlink-older-quote-skipped",
          severity: "info",
          message: "Skipping older Chainlink quote.",
          metadata: { pegKey, chainlinkUpdatedAt: quote.updatedAt, existingUpdatedAt },
        });
        continue;
      }

      const existing = this.usableRates[pegKey];
      if (existing != null && existing > 0) {
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
          continue;
        }
      }

      const normalized = Number(quote.price.toFixed(6));
      if (this.validateRate(pegKey, normalized, this.prevRates[pegKey])) {
        if (quoteOlderThanCurrent && metalPegKey && existing != null && existing > 0) {
          this.recordCronEvent({
            eventType: "chainlink-older-metal-quote-validated",
            severity: "info",
            message: "Validated older Chainlink metal quote against current reference.",
            metadata: {
              pegKey,
              currentRate: existing,
              chainlinkRate: normalized,
              chainlinkUpdatedAt: quote.updatedAt,
              existingUpdatedAt,
            },
          });
          accepted++;
          continue;
        }
        this.usableRates[pegKey] = normalized;
        applyRealtimeOverlaySourceMetadata(
          pegKey,
          quote.updatedAt,
          this.syncStartSec,
          this.sourceUpdatedAtByPeg,
          this.sourceModeByPeg,
          this.sourceCadenceByPeg,
          this.sourceDateByPeg,
        );
        accepted++;
      } else if (this.prevRates[pegKey]) {
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
    if (typeof this.prevRates[pegKey] !== "number" || this.prevRates[pegKey] <= 0) {
      return false;
    }
    if (options.requireCadenceValid && getFxSourceStatus(
      this.prevState?.sourceUpdatedAtByPeg[pegKey] ?? null,
      this.prevState?.sourceModeByPeg[pegKey],
      this.syncStartSec,
      {
        pegKey,
        cadence: this.prevState?.sourceCadenceByPeg[pegKey],
        sourceDate: this.prevState?.sourceDateByPeg[pegKey] ?? null,
      },
    ) !== "fresh") {
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
    if (typeof currentRate === "number" && currentRate > 0 && getFxSourceStatus(
      this.sourceUpdatedAtByPeg[pegKey] ?? null,
      this.sourceModeByPeg[pegKey],
      this.syncStartSec,
      {
        pegKey,
        cadence: this.sourceCadenceByPeg[pegKey],
        sourceDate: this.sourceDateByPeg[pegKey] ?? null,
      },
    ) === "fresh") {
      return true;
    }

    delete this.usableRates[pegKey];
    delete this.sourceUpdatedAtByPeg[pegKey];
    delete this.sourceModeByPeg[pegKey];
    delete this.sourceCadenceByPeg[pegKey];
    delete this.sourceDateByPeg[pegKey];
    return this.ensureCachedRate(pegKey, label, { requireCadenceValid: true });
  }

  applyResolvedMetals(metals: MetalsResolution): void {
    for (const pegKey of ["peggedGOLD", "peggedSILVER"] as const) {
      const resolved = metals.resolvedByPeg[pegKey];
      if (!resolved) continue;

      this.usableRates[pegKey] = resolved.rate;
      if (resolved.source === "cached") {
        this.inheritPrevious(pegKey);
      } else {
        this.markLive(pegKey, resolved.updatedAt ?? this.syncStartSec);
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
    return {
      usableSyncAt: this.syncStartSec,
      mode: this.mode,
      sourceUpdatedAtByPeg: this.sourceUpdatedAtByPeg,
      sourceModeByPeg: this.sourceModeByPeg,
      sourceCadenceByPeg: this.sourceCadenceByPeg,
      sourceDateByPeg: this.sourceDateByPeg,
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

  const [lastAttempt, legacyLastFetch] = await Promise.all([
    db.prepare("SELECT value FROM cache WHERE key = ?").bind(OXR_LAST_ATTEMPT_KEY).first<{ value: string }>(),
    db.prepare("SELECT value FROM cache WHERE key = ?").bind(OXR_LEGACY_LAST_FETCH_KEY).first<{ value: string }>(),
  ]);
  const lastFetchTime = lastAttempt ? parseInt(lastAttempt.value, 10)
    : legacyLastFetch ? parseInt(legacyLastFetch.value, 10)
      : 0;
  const elapsedMinutes = (Math.floor(Date.now() / 1000) - lastFetchTime) / 60;

  if (elapsedMinutes < OXR_RATE_LIMIT_MINUTES) {
    await logCronEvent(db, {
      job: "sync-fx-rates",
      eventType: "openexchange-rates-rate-limited",
      severity: "info",
      message: `Skipping Open Exchange Rates fetch because the ${OXR_RATE_LIMIT_MINUTES}-minute rate limit window is still active.`,
      metadata: { elapsedMinutes: Math.round(elapsedMinutes), rateLimitMinutes: OXR_RATE_LIMIT_MINUTES },
    });
    return "rate-limited";
  }

  return withFxOverlayCircuit(db, {
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
      const attemptedAt = Math.floor(Date.now() / 1000);
      const realtimeFetch = await fetchRealtimeFxRates(openExchangeRatesKey, signal);
      if (realtimeFetch.completed) {
        await runBestEffort("fx-oxr-last-fetch-write", async () => {
          await setCache(db, OXR_LAST_ATTEMPT_KEY, String(attemptedAt));
        });
      }

      const realtimeApplied = state.applyRealtimeOverlayRates(realtimeFetch.rates);
      if (realtimeFetch.rates.size > 0) {
        await runBestEffort("fx-oxr-last-success-write", async () => {
          await setCache(db, OXR_LAST_SUCCESS_KEY, String(attemptedAt));
        });
      }

      await logCronEvent(db, {
        job: "sync-fx-rates",
        eventType: "openexchange-rates-applied",
        severity: realtimeApplied === realtimeFetch.rates.size ? "info" : "warning",
        message: "Applied realtime FX overlay rates.",
        metadata: { applied: realtimeApplied, available: realtimeFetch.rates.size },
      });
      await runBestEffort("recordOutcome:fx-realtime", async () => {
        await recordOutcome(db, CIRCUIT_SOURCE.FX_REALTIME, realtimeFetch.rates.size > 0);
      });
      return realtimeFetch.rates.size > 0
        ? (realtimeApplied === realtimeFetch.rates.size ? "ok" : "partial")
        : "unavailable";
    },
  });
}

export async function runChainlinkOverlay(
  db: D1Database,
  state: FxSyncRunState,
  signal: AbortSignal | undefined,
  chainRpcs: Map<string, ChainRpcConfig> | undefined,
  drpcApiKey: string | null | undefined,
  etherscanApiKey: string | null | undefined,
  runBestEffort: RunBestEffort,
): Promise<ChainlinkSourceStatus> {
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
      const accepted = state.applyChainlinkQuotes(snapshot.quotes);
      await runBestEffort("recordOutcome:chainlink-feeds", async () => {
        await recordOutcome(db, CIRCUIT_SOURCE.CHAINLINK_FEEDS, snapshot.quotes.size > 0);
      });
      await runBestEffort("setCache:chainlink-failing-runs", async () => {
        await setCache(db, CHAINLINK_FAILING_RUNS_CACHE_KEY, JSON.stringify(snapshot.failingRuns));
      });
      return snapshot.quotes.size > 0
        ? (accepted === snapshot.quotes.size ? "ok" : "partial")
        : "unavailable";
    },
  });
}
