import { DAY_SECONDS } from "@shared/lib/time-constants";
import { CIRCUIT_SOURCE } from "../lib/constants";
import { fetchRealtimeFxRates } from "../lib/fx-realtime";
import { fetchChainlinkReferenceQuoteSnapshot, type ChainlinkReferenceQuote } from "../lib/chainlink-feeds";
import type { ChainRpcConfig } from "../lib/chain-registry";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import type { MetalsResolution } from "../lib/fx-metals";
import type { FxRateSourceMode, FxRateState, FxRateSyncMode, FxRatesMeta, FxSourceCadence } from "../lib/fx-rate-state";
import { getFxSourceStatus } from "../lib/fx-rate-state";
import {
  applyRealtimeOverlaySourceMetadata,
  canCarryForwardFxRates,
  inheritFxSourceMetadata,
} from "../lib/fx-source-metadata";

export interface SecondaryCurrencyPayload {
  date?: string;
  usd: Record<string, number>;
}

export type SecondaryCurrencyEndpoint = "jsdelivr" | "pages.dev";

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

export type OpenExchangeRatesSourceStatus = "ok" | "partial" | "rate-limited" | "unavailable";
export type ChainlinkSourceStatus = "ok" | "partial" | "unavailable";

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
  readonly validateRate: FxSyncRunStateParams["validateRate"];

  readonly sourceUpdatedAtByPeg: Record<string, number | null> = {};
  readonly sourceModeByPeg: Record<string, FxRateSourceMode> = {};
  readonly sourceCadenceByPeg: Record<string, FxSourceCadence> = {};
  readonly sourceDateByPeg: Record<string, string | null> = {};

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

  setHardcoded(pegKey: string): void {
    this.sourceModeByPeg[pegKey] = "hardcoded";
    this.sourceUpdatedAtByPeg[pegKey] = null;
    this.sourceCadenceByPeg[pegKey] = "intraday";
    this.sourceDateByPeg[pegKey] = null;
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

  seedCachedFallbackFromPrevious(): void {
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
      if (typeof perUsd === "number" && perUsd > 0) {
        const rate = Number((1 / perUsd).toFixed(6));
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
      console.warn(
        `[sync-fx-rates] ECB rates are ${Math.round(ecbAgeSec / 3600)}h stale (date=${sourceDate}). ` +
        "Weekend/holiday — non-USD pegs using last published rates.",
      );
    }

    for (const [currency, unitsPerUsd] of Object.entries(rates)) {
      const pegKey = currencyToPeg[currency];
      if (!pegKey || unitsPerUsd <= 0) continue;
      const rate = Number((1 / unitsPerUsd).toFixed(6));
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

    for (const [pegKey, realtimeRate] of rates) {
      const currentRate = this.usableRates[pegKey];
      if (currentRate != null) {
        const delta = Math.abs(realtimeRate - currentRate) / currentRate;
        if (delta <= 0.05) {
          if (this.validateRate(pegKey, realtimeRate, this.prevRates[pegKey])) {
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
          }
        } else {
          console.warn(
            `[sync-fx-rates] ${pegKey} diverges: current=${currentRate}, realtime=${realtimeRate} ` +
            `(${(delta * 100).toFixed(1)}%)`,
          );
        }
      } else if (this.validateRate(pegKey, realtimeRate, this.prevRates[pegKey])) {
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
      }
    }

    return applied;
  }

  applyChainlinkQuotes(quotes: Map<string, ChainlinkReferenceQuote>): number {
    let applied = 0;

    for (const [pegKey, quote] of quotes) {
      const existingUpdatedAt = this.sourceUpdatedAtByPeg[pegKey] ?? null;
      if (
        existingUpdatedAt != null &&
        Number.isFinite(existingUpdatedAt) &&
        existingUpdatedAt > 0 &&
        quote.updatedAt < existingUpdatedAt
      ) {
        console.log(
          `[sync-fx-rates] Skipping older Chainlink ${pegKey} quote: ` +
            `chainlink=${quote.updatedAt}, existing=${existingUpdatedAt}`,
        );
        continue;
      }

      const existing = this.usableRates[pegKey];
      if (existing != null && existing > 0) {
        const delta = Math.abs(quote.price - existing) / existing;
        if (delta > 0.05) {
          console.warn(
            `[sync-fx-rates] Chainlink ${pegKey} diverges from current reference: ` +
            `current=${existing}, chainlink=${quote.price} (${(delta * 100).toFixed(1)}%)`,
          );
          continue;
        }
      }

      const normalized = Number(quote.price.toFixed(6));
      if (this.validateRate(pegKey, normalized, this.prevRates[pegKey])) {
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
        applied++;
      } else if (this.prevRates[pegKey]) {
        this.usableRates[pegKey] = this.prevRates[pegKey]!;
        this.inheritPrevious(pegKey);
      }
    }

    return applied;
  }

  ensureCachedRate(pegKey: string, label: string): boolean {
    if (typeof this.prevRates[pegKey] !== "number" || this.prevRates[pegKey] <= 0) {
      return false;
    }

    this.usableRates[pegKey] = this.prevRates[pegKey]!;
    this.inheritPrevious(pegKey);
    console.log(`[sync-fx-rates] Using cached ${label} rate: ${this.usableRates[pegKey]}`);
    return true;
  }

  ensureCachedOrHardcodedRate(pegKey: string, label: string, fallbackRate: number): void {
    if (pegKey in this.usableRates) return;
    if (this.ensureCachedRate(pegKey, label)) return;

    this.usableRates[pegKey] = fallbackRate;
    this.setHardcoded(pegKey);
    console.log(`[sync-fx-rates] Using hardcoded ${label} fallback: ${fallbackRate}`);
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

  maybeRecoverFromCachedFallback(): void {
    if (this.mode !== "cached-fallback" || !this.hasFreshFullFxCoverage()) return;

    this.mode = "live";
    this.fallbackMode = "independent-live-recovery";
    if (this.sources.cache === "ok") {
      this.sources.cache = "recovered";
    }
    console.log("[sync-fx-rates] Independent sources restored fresh full-set coverage after cached fallback");
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
    return {
      rateCount: Object.keys(this.usableRates).length,
      mode: this.mode,
      fallbackMode: this.fallbackMode,
      missing: missing.length > 0 ? missing : undefined,
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

  const OXR_LAST_ATTEMPT_KEY = "fx-oxr-last-attempt";
  const OXR_LAST_SUCCESS_KEY = "fx-oxr-last-success";
  const OXR_LEGACY_LAST_FETCH_KEY = "fx-oxr-last-fetch";
  const [lastAttempt, legacyLastFetch] = await Promise.all([
    db.prepare("SELECT value FROM cache WHERE key = ?").bind(OXR_LAST_ATTEMPT_KEY).first<{ value: string }>(),
    db.prepare("SELECT value FROM cache WHERE key = ?").bind(OXR_LEGACY_LAST_FETCH_KEY).first<{ value: string }>(),
  ]);
  const lastFetchTime = lastAttempt ? parseInt(lastAttempt.value, 10)
    : legacyLastFetch ? parseInt(legacyLastFetch.value, 10)
      : 0;
  const elapsedMinutes = (Math.floor(Date.now() / 1000) - lastFetchTime) / 60;

  if (elapsedMinutes < 55) {
    console.log(
      `[sync-fx-rates] Skipping OXR fetch (last fetch ${Math.round(elapsedMinutes)}min ago, rate limit: 55min)`,
    );
    return "rate-limited";
  }

  try {
    const completedAt = Math.floor(Date.now() / 1000);
    const realtimeFetch = await fetchRealtimeFxRates(openExchangeRatesKey, signal);
    if (realtimeFetch.completed) {
      await runBestEffort("fx-oxr-last-fetch-write", async () => {
        await db.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
          .bind(OXR_LAST_ATTEMPT_KEY, String(completedAt), completedAt).run();
      });
    }

    const realtimeApplied = state.applyRealtimeOverlayRates(realtimeFetch.rates);
    if (realtimeFetch.rates.size > 0) {
      await runBestEffort("fx-oxr-last-success-write", async () => {
        await db.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
          .bind(OXR_LAST_SUCCESS_KEY, String(completedAt), completedAt).run();
      });
    }

    console.log(
      `[sync-fx-rates] Applied ${realtimeApplied}/${realtimeFetch.rates.size} real-time FX rates`,
    );
    await runBestEffort("recordOutcome:fx-realtime", async () => {
      await recordOutcome(db, CIRCUIT_SOURCE.FX_REALTIME, realtimeFetch.completed);
    });
    return realtimeFetch.rates.size > 0
      ? (realtimeApplied === realtimeFetch.rates.size ? "ok" : "partial")
      : "unavailable";
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn("[sync-fx-rates] OXR real-time fetch failed:", err);
    await runBestEffort("recordOutcome:fx-realtime-failure", async () => {
      await recordOutcome(db, CIRCUIT_SOURCE.FX_REALTIME, false);
    });
    return "unavailable";
  }
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
  const chainlinkAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.CHAINLINK_FEEDS);
  if (!chainlinkAllowed) {
    console.warn("[sync-fx-rates] Chainlink reference-feed circuit open — skipping overlay");
    return "unavailable";
  }

  try {
    const snapshot = await fetchChainlinkReferenceQuoteSnapshot(
      signal,
      chainRpcs,
      state.syncStartSec,
      drpcApiKey,
      etherscanApiKey,
    );
    const applied = state.applyChainlinkQuotes(snapshot.quotes);
    await runBestEffort("recordOutcome:chainlink-feeds", async () => {
      await recordOutcome(db, CIRCUIT_SOURCE.CHAINLINK_FEEDS, snapshot.quotes.size > 0);
    });
    return snapshot.quotes.size > 0
      ? (applied === snapshot.quotes.size ? "ok" : "partial")
      : "unavailable";
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn("[sync-fx-rates] Chainlink reference feeds failed:", err);
    await runBestEffort("recordOutcome:chainlink-feeds-failure", async () => {
      await recordOutcome(db, CIRCUIT_SOURCE.CHAINLINK_FEEDS, false);
    });
    return "unavailable";
  }
}
