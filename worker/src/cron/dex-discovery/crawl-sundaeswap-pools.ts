import { canonicalExitRouteScopedKey } from "@shared/types/exit-route-identity";
import { readRecord as asRecord } from "@shared/lib/type-guards";
import { BPS_PER_UNIT, toTokenUnits } from "@shared/lib/math";
import { DAY_SECONDS, HOUR_SECONDS } from "@shared/lib/time-constants";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { isSundaeSwapDiscoveryDeployment } from "@shared/lib/dex-deployment-coverage";
import { WORKER_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/worker-runtime-registry";
import type { ContractDeployment } from "@shared/types/stablecoin-meta-primitives";
import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import { recordOutcomeSafe, shouldAttemptFetch } from "../../lib/circuit-breaker";
import { cgHeaders, cgSimplePricePath, cgUrl } from "../../lib/coingecko";
import { CIRCUIT_SOURCE, USER_AGENT } from "../../lib/constants";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import { buildPriceValidationContext, getReferencePriceForContext } from "../../lib/price-validation";
import { validatePricingSourceFreshness } from "../../lib/pricing-source-freshness";
import { CoinGeckoSimplePriceEntrySchema, CoinGeckoSimplePriceSchema } from "../../lib/upstream-schemas";
import { DEX_LIQUIDITY_POOL_MIN_TVL_USD } from "../dex-liquidity/constants";
import { passesUsdVolumeSourcePreflight } from "../dex-liquidity/pool-volume-sanity";
import { isPlausibleDexObservationPrice } from "../dex-liquidity/price-sanity";
import { fetchDexDiscoveryJsonEndpoint } from "./fetch-json-endpoint";
import { type CrawlStageContext, toStagedPool } from "./staged-pool";
import { STAGED_POOL_MAX_TVL_USD, makeDexDeploymentProviderCheck, type DexDeploymentProviderCheck } from "./types";

/** SundaeSwap's keyless GraphQL index covers its V1, V3, Stableswaps and V4 pools. */
const SUNDAESWAP_GRAPHQL_URL = "https://api.sundae.fi/graphql";
const SUNDAESWAP_POOLS_QUERY =
  "query($asset: ID!, $start: String!, $end: String!) { pools { byAsset(asset: $asset) { id version bidFee askFee prices rates quantities assets { id ticker } modules { kind identifier } current { asOf { unixMilli } } ticks(interval: Hourly, start: $start, end: $end) { rich { start { unixMilli } end { unixMilli } volume(unit: AssetA) { quantity asset { id decimals } } } } } } }";
/**
 * `byAsset` takes no pagination and silently stops at 50 rows (2026-11-15:
 * ADA returned exactly 50 of 3,340 pools), so a full page is a capped read.
 */
const SUNDAESWAP_BY_ASSET_ROW_CAP = 50;
/** A capped 50-row answer to this query measured 16 KB on 2026-11-15. */
const SUNDAESWAP_MAX_RESPONSE_BYTES = 256 * 1024;
const SUNDAESWAP_TIMEOUT_MS = 8_000;
const SUNDAESWAP_MAX_RETRIES = 1;
const SUNDAESWAP = "sundaeswap";
const SUNDAESWAP_AS_OF_FUTURE_GRACE_SEC = 300;
const ADA_REGISTRY_ASSET = "0x";
const ADA_DECIMALS = 6;
const ADA_USD_MAX_SANITY_PRICE = 100_000;
const ADA_REFERENCE_TIMEOUT_MS = 6_000;
const ADA_REFERENCE_MAX_RETRIES = 1;
const ADA_REFERENCE_MAX_RESPONSE_BYTES = 16 * 1024;
const SUNDAESWAP_LEG_DIVISOR = new Map<string, number>([
  ["V1", 1],
  ["V3", 1],
  ["Stableswaps", 1],
  ["V4", 2],
]);

export interface SundaeSwapAdaUsdReference {
  priceUsd: number;
  observedAtSec: number;
  source: "coingecko";
}

export type SundaeSwapAdaUsdFailureReason = "circuit-open" | "fetch-failed" | "invalid" | "stale";

export interface SundaeSwapAdaUsdDiagnostic {
  status: "ok" | SundaeSwapAdaUsdFailureReason;
  observedAtSec: number | null;
  ageSec: number | null;
}

export interface SundaeSwapAdaUsdLoadResult extends SundaeSwapAdaUsdDiagnostic {
  reference: SundaeSwapAdaUsdReference | null;
}

export type SundaeSwapAdaUsdLoader = () => Promise<SundaeSwapAdaUsdLoadResult | SundaeSwapAdaUsdReference | null>;

/** Validate a clocked CoinGecko ADA/USD quote under the shared freshness authority. */
function validateSundaeSwapAdaUsdQuote(
  priceUsd: unknown,
  observedAtSec: unknown,
  nowSec: number,
): SundaeSwapAdaUsdLoadResult {
  if (
    typeof priceUsd !== "number"
    || !Number.isFinite(priceUsd)
    || priceUsd <= 0
    || priceUsd >= ADA_USD_MAX_SANITY_PRICE
    || typeof observedAtSec !== "number"
    || !Number.isSafeInteger(observedAtSec)
    || observedAtSec <= 0
  ) {
    return { reference: null, status: "invalid", observedAtSec: null, ageSec: null };
  }
  const freshness = validatePricingSourceFreshness({
    source: "coingecko",
    observedAt: observedAtSec,
    observedAtMode: "upstream",
    nowSec,
    requireObservedAt: true,
    maxFutureSkewSec: SUNDAESWAP_AS_OF_FUTURE_GRACE_SEC,
  });
  const ageSec = nowSec - observedAtSec;
  if (!freshness.accepted) {
    return {
      reference: null,
      status: freshness.reason === "stale_observed_at" ? "stale" : "invalid",
      observedAtSec,
      ageSec,
    };
  }
  return {
    reference: { priceUsd, observedAtSec, source: "coingecko" },
    status: "ok",
    observedAtSec,
    ageSec,
  };
}

/**
 * Run-local lazy memoized ADA/USD reference loader for SundaeSwap discovery.
 * Checks `CG_PRICES` via `shouldAttemptFetch` without calling `recordOutcome`,
 * fetches once per discovery run only when an eligible ADA constant-product
 * pool is encountered, and records operator diagnostics only once attempted.
 */
export function createSundaeSwapAdaUsdLoader(input: {
  db: D1Database;
  cgApiKey: string | null;
  deadlineMs: number;
  finalizationTailBudgetMs: number;
  signal?: AbortSignal;
}): {
  load: () => Promise<SundaeSwapAdaUsdLoadResult>;
  getDiagnostic: () => SundaeSwapAdaUsdDiagnostic | null;
} {
  let pending: Promise<SundaeSwapAdaUsdLoadResult> | undefined;
  let diagnostic: SundaeSwapAdaUsdDiagnostic | null = null;

  const record = (result: SundaeSwapAdaUsdLoadResult): SundaeSwapAdaUsdLoadResult => {
    diagnostic = {
      status: result.status,
      observedAtSec: result.observedAtSec,
      ageSec: result.ageSec,
    };
    return result;
  };

  const fetchOnce = async (): Promise<SundaeSwapAdaUsdLoadResult> => {
    throwIfAborted(input.signal);
    if (!(await shouldAttemptFetch(input.db, CIRCUIT_SOURCE.CG_PRICES))) {
      return record({ reference: null, status: "circuit-open", observedAtSec: null, ageSec: null });
    }
    const remainingMs = Math.min(
      input.deadlineMs - input.finalizationTailBudgetMs - Date.now(),
      ADA_REFERENCE_TIMEOUT_MS,
    );
    if (remainingMs <= 0) {
      return record({ reference: null, status: "fetch-failed", observedAtSec: null, ageSec: null });
    }
    const timeout = createTimeoutSignal({
      timeoutMs: remainingMs,
      timeoutReason: new DOMException("SundaeSwap ADA/USD reference fetch timed out", "TimeoutError"),
      parentSignal: input.signal,
    });
    try {
      const response = await fetchJsonWithRetry<unknown>(
        cgUrl(cgSimplePricePath("ids=cardano&vs_currencies=usd&include_last_updated_at=true"), input.cgApiKey),
        {
          headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }, input.cgApiKey),
          signal: timeout.signal,
        },
        ADA_REFERENCE_MAX_RETRIES,
        {
          timeoutMs: remainingMs,
          maxResponseBytes: ADA_REFERENCE_MAX_RESPONSE_BYTES,
          returnFinalResponse: true,
        },
      );
      throwIfAborted(input.signal);
      if (!response || !response.response.ok) {
        return record({ reference: null, status: "fetch-failed", observedAtSec: null, ageSec: null });
      }
      const root = CoinGeckoSimplePriceSchema.safeParse(response.body);
      const entry = root.success ? CoinGeckoSimplePriceEntrySchema.safeParse(root.data.cardano) : null;
      if (!entry?.success) {
        return record({ reference: null, status: "invalid", observedAtSec: null, ageSec: null });
      }
      return record(validateSundaeSwapAdaUsdQuote(
        entry.data.usd,
        entry.data.last_updated_at,
        Math.floor(Date.now() / 1000),
      ));
    } catch (error) {
      rethrowIfAborted(error, input.signal);
      return record({ reference: null, status: "fetch-failed", observedAtSec: null, ageSec: null });
    } finally {
      timeout.dispose();
    }
  };

  return {
    load: () => (pending ??= fetchOnce()),
    getDiagnostic: () => diagnostic,
  };
}

const LEGACY_SHAPES = new Map([["V1", "constant-product"], ["V3", "constant-product"], ["Stableswaps", "stableswap"]]);
const UNVALUED = { tvlUsd: null, priceUsd: null } as const;
const NO_VOLUME = { volume24h: null, volumeWindowEndSec: null } as const;

interface SundaePool {
  id: string;
  version: string;
  /** Curve family: legacy version or the V4 invariant module, e.g. `constant-sum`. */
  shape: string;
  feeBps: number | null;
  /** Configured V4 constant-sum prices / stableswap rates are all equal (vacuous before V4). */
  oneToOne: boolean;
  assets: Array<{ id: string; ticker: string }>;
  quantities: bigint[];
  asOfMs: number | null;
  tickRows: unknown[] | null;
}

export interface SundaeSwapPoolsStageResult {
  providerChecks: DexDeploymentProviderCheck[];
  stoppedEarly?: boolean;
}

/** Provider-local diagnostic class of a degraded census or skipped ADA valuation. */
type SundaeSwapProviderCheck = DexDeploymentProviderCheck & {
  error?: string;
  adaValuationReason?: `ada-usd-${SundaeSwapAdaUsdFailureReason}`;
  adaValuationSkippedCount?: number;
};

/** Active tracked Cardano assets: the only counters whose peg reference can value a pool. */
const trackedCardanoAssets = new Map<string, { stablecoinId: string; decimals: number | null }>();
for (const coin of WORKER_ACTIVE_STABLECOINS) {
  for (const deployment of [...(coin.contracts ?? []), ...(coin.tradedContracts ?? [])]) {
    if (isSundaeSwapDiscoveryDeployment(deployment.chain, deployment.address)) {
      trackedCardanoAssets.set(deployment.address, { stablecoinId: coin.id, decimals: deployment.decimals });
    }
  }
}

/**
 * SundaeSwap writes `policyId.assetNameHex`; the catalog stores the two hex
 * parts without the dot. Native ADA takes `0x`, the identity GeckoTerminal and
 * DexScreener rows already carry, so one Cardano token keeps one identity.
 */
function toRegistryAsset(id: unknown): string | null {
  if (id === "ada.lovelace") return "0x";
  if (typeof id !== "string" || id[56] !== ".") return null;
  const registryId = `${id.slice(0, 56)}${id.slice(57)}`;
  return isSundaeSwapDiscoveryDeployment("cardano", registryId) ? registryId : null;
}

/** Fee fractions arrive as `[numerator, denominator]`; a pool's tier is the higher of bid and ask. */
function parseFeeBps(value: unknown): number | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [numerator, denominator]: unknown[] = value;
  if (typeof numerator !== "number" || typeof denominator !== "number") return null;
  return Number.isSafeInteger(numerator) && Number.isSafeInteger(denominator) && numerator >= 0 && denominator > numerator
    ? (numerator * BPS_PER_UNIT) / denominator
    : null;
}

function formatSundaeUtc(epochSec: number): string {
  return new Date(epochSec * 1_000).toISOString().slice(0, 19).replace("T", " ");
}

function parseUnixMilli(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

function parsePool(value: unknown): SundaePool | null {
  const row = asRecord(value);
  const assetRows: unknown[] | null = Array.isArray(row?.assets) ? row.assets : null;
  const quantityRows: unknown[] | null = Array.isArray(row?.quantities) ? row.quantities : null;
  if (
    row == null || typeof row.id !== "string" || !/^[0-9a-f]{2,64}$/u.test(row.id) ||
    assetRows == null || quantityRows == null || assetRows.length < 2 || quantityRows.length !== assetRows.length
  ) {
    return null;
  }
  const assets = assetRows.map((asset) => {
    const record = asRecord(asset);
    const id = toRegistryAsset(record?.id);
    const ticker = record?.ticker;
    return id == null ? null : {
      id,
      ticker: typeof ticker === "string" && /^[\w.$-]{1,24}$/u.test(ticker)
        ? ticker
        : id === ADA_REGISTRY_ASSET ? "ADA" : id.slice(0, 8),
    };
  });
  const quantities = quantityRows.map((quantity) =>
    typeof quantity === "string" && /^(?:0|[1-9]\d*)$/u.test(quantity) ? BigInt(quantity) : null);
  if (assets.some((asset) => asset == null) || quantities.some((quantity) => quantity == null)) return null;
  if (new Set(assets.map((asset) => asset!.id)).size !== assets.length) return null;

  const modules: unknown[] = Array.isArray(row.modules) ? row.modules : [];
  const invariant = asRecord(modules.find((module) => asRecord(module)?.kind === "invariant"))?.identifier;
  const version = typeof row.version === "string" ? row.version : "";
  const shape = LEGACY_SHAPES.get(version) ??
    (version === "V4" && typeof invariant === "string" && /^[a-z_]{1,40}$/u.test(invariant)
      ? invariant.replaceAll("_", "-")
      : "unknown");
  const configuredRates: unknown[] = [
    ...(Array.isArray(row.prices) ? row.prices : []),
    ...(Array.isArray(row.rates) ? row.rates : []),
  ];
  const bidBps = parseFeeBps(row.bidFee);
  const askBps = parseFeeBps(row.askFee);
  const asOfMs = parseUnixMilli(asRecord(asRecord(row.current)?.asOf)?.unixMilli);
  const rawRich = asRecord(row.ticks)?.rich;
  const tickRows = Array.isArray(rawRich) ? rawRich : null;
  return {
    id: row.id,
    version,
    shape,
    feeBps: bidBps == null || askBps == null ? null : Math.max(bidBps, askBps),
    oneToOne: configuredRates.every((rate) => rate === configuredRates[0]),
    assets: assets as SundaePool["assets"],
    quantities: quantities as bigint[],
    asOfMs,
    tickRows,
  };
}

function tokenAmount(raw: bigint | undefined, decimals: number | null | undefined): number | null {
  return raw == null || decimals == null ? null : toTokenUnits(raw, decimals);
}

function isAdaConstantProductPair(pool: SundaePool, trackedIndex: number): boolean {
  return (
    pool.assets.length === 2
    && pool.shape === "constant-product"
    && pool.assets[1 - trackedIndex]?.id === ADA_REGISTRY_ASSET
  );
}

async function resolveAdaUsdReference(
  loader: SundaeSwapAdaUsdLoader,
  nowSec: number,
): Promise<SundaeSwapAdaUsdLoadResult> {
  const loaded = await loader();
  if (loaded == null) {
    return { reference: null, status: "fetch-failed", observedAtSec: null, ageSec: null };
  }
  if ("reference" in loaded) {
    if (loaded.reference == null) return loaded;
    return validateSundaeSwapAdaUsdQuote(loaded.reference.priceUsd, loaded.reference.observedAtSec, nowSec);
  }
  return validateSundaeSwapAdaUsdQuote(loaded.priceUsd, loaded.observedAtSec, nowSec);
}

/**
 * USD value comes from a two-asset pool whose counter is either another active
 * tracked Cardano stablecoin with a usable peg reference, or native ADA (`0x`)
 * on a constant-product invariant (`V1`, `V3`, `V4 constant_product`) when a
 * fresh clocked CoinGecko ADA/USD quote is available. Constant-product pools
 * hold equal value on both sides at their marginal price, so TVL is twice the
 * counter's value and the implied tracked price must pass the shared
 * plausibility gate; ADA pairs keep `priceUsd: null` so volatile CoinGecko
 * ADA/USD quotes never leak into independent DEX price evidence. Stable-curve
 * pools (Stableswaps, V4 stableswap, V4 constant-sum) with a 1:1 configured
 * rate and equal decimals count twice the matched depth (as TzKT) and stage no
 * price. Anything else keeps its observed identity with a null value.
 */
function valuePool(
  pool: SundaePool,
  trackedIndex: number,
  target: ContractDeployment,
  context: CrawlStageContext,
  adaUsdRef: SundaeSwapAdaUsdReference | null,
): { tvlUsd: number | null; priceUsd: number | null } {
  if (pool.assets.length !== 2) return UNVALUED;
  const counterAssetId = pool.assets[1 - trackedIndex]!.id;
  const trackedAmount = tokenAmount(pool.quantities[trackedIndex], target.decimals);
  if (counterAssetId === ADA_REGISTRY_ASSET) {
    if (pool.shape !== "constant-product" || adaUsdRef == null) return UNVALUED;
    const adaAmount = tokenAmount(pool.quantities[1 - trackedIndex], ADA_DECIMALS);
    if (trackedAmount == null || adaAmount == null || trackedAmount <= 0 || adaAmount <= 0) return UNVALUED;
    const impliedPriceUsd = (adaAmount * adaUsdRef.priceUsd) / trackedAmount;
    return isPlausibleDexObservationPrice(context.stablecoinId, impliedPriceUsd, context.references)
      ? { tvlUsd: 2 * adaAmount * adaUsdRef.priceUsd, priceUsd: null }
      : UNVALUED;
  }
  const counter = trackedCardanoAssets.get(counterAssetId);
  const counterRef = counter
    ? getReferencePriceForContext(buildPriceValidationContext({ stablecoinId: counter.stablecoinId }), context.references)
    : null;
  const counterAmount = tokenAmount(pool.quantities[1 - trackedIndex], counter?.decimals);
  if (counterRef == null || trackedAmount == null || counterAmount == null) return UNVALUED;
  if (pool.shape === "constant-product") {
    const priceUsd = (counterAmount * counterRef) / trackedAmount;
    return isPlausibleDexObservationPrice(context.stablecoinId, priceUsd, context.references)
      ? { tvlUsd: 2 * counterAmount * counterRef, priceUsd }
      : UNVALUED;
  }
  const stableCurve = pool.shape === "stableswap" || pool.shape === "constant-sum";
  return stableCurve && pool.oneToOne && target.decimals === counter!.decimals
    ? { tvlUsd: 2 * Math.min(trackedAmount, counterAmount) * counterRef, priceUsd: null }
    : UNVALUED;
}

/**
 * Compute 24h USD volume for an already-valued pool from the hourly `ticks`
 * buckets (denominated in `AssetA`) returned inside the 24 complete hours
 * ending at the window end. V1, V3, and Stableswaps report single-leg volume
 * (1x); V4 reports double-leg volume (÷2). When `AssetA` is native ADA (`0x`),
 * units are converted with 6 lovelace decimals and the fresh clocked ADA/USD
 * reference; when `AssetA` is a tracked stablecoin, its peg reference is used.
 * SundaeSwap omits zero-trade hours, and `current.asOf` is the index's
 * response clock (current for idle pools too), so only an in-window bucket
 * proves the tick feed: an empty window is unmeasured, never zero. Also fails
 * closed to null on partial GraphQL errors, stale/missing `current.asOf`,
 * unknown versions, malformed ticks, or excessive turnover.
 */
function valuePoolVolume24h(
  pool: SundaePool,
  trackedIndex: number,
  target: ContractDeployment,
  tvlUsd: number | null,
  hasGraphqlErrors: boolean,
  context: CrawlStageContext,
  adaUsdRef: SundaeSwapAdaUsdReference | null,
): { volume24h: number | null; volumeWindowEndSec: number | null } {
  if (hasGraphqlErrors || tvlUsd == null || tvlUsd < DEX_LIQUIDITY_POOL_MIN_TVL_USD) return NO_VOLUME;
  const legDivisor = SUNDAESWAP_LEG_DIVISOR.get(pool.version) ?? null;
  if (legDivisor == null || pool.asOfMs == null || pool.tickRows == null) return NO_VOLUME;
  const asOfSec = Math.floor(pool.asOfMs / 1_000);
  const floorHourSec = Math.floor(context.nowSec / HOUR_SECONDS) * HOUR_SECONDS;
  if (asOfSec <= 0 || asOfSec > context.nowSec + SUNDAESWAP_AS_OF_FUTURE_GRACE_SEC) return NO_VOLUME;
  const effectiveWindowEndSec = Math.min(floorHourSec, Math.floor(asOfSec / HOUR_SECONDS) * HOUR_SECONDS);
  if (effectiveWindowEndSec <= 0 || effectiveWindowEndSec < floorHourSec - HOUR_SECONDS) return NO_VOLUME;

  const assetA = pool.assets[0];
  if (!assetA) return NO_VOLUME;
  let assetADecimals: number | null;
  let assetARef: number | null;
  if (assetA.id === ADA_REGISTRY_ASSET) {
    if (adaUsdRef == null) return NO_VOLUME;
    assetADecimals = ADA_DECIMALS;
    assetARef = adaUsdRef.priceUsd;
  } else {
    const assetAInfo = trackedIndex === 0
      ? { stablecoinId: context.stablecoinId, decimals: target.decimals }
      : trackedCardanoAssets.get(assetA.id);
    if (!assetAInfo || assetAInfo.decimals == null) return NO_VOLUME;
    assetADecimals = assetAInfo.decimals;
    assetARef = getReferencePriceForContext(
      buildPriceValidationContext({ stablecoinId: assetAInfo.stablecoinId }),
      context.references,
    );
  }
  if (assetADecimals == null || assetARef == null || !Number.isFinite(assetARef) || assetARef <= 0) return NO_VOLUME;

  const windowStartSec = effectiveWindowEndSec - DAY_SECONDS;
  const qtyByStartSec = new Map<number, bigint>();
  for (const rawTick of pool.tickRows) {
    const tick = asRecord(rawTick);
    const startMs = parseUnixMilli(asRecord(tick?.start)?.unixMilli);
    const endMs = parseUnixMilli(asRecord(tick?.end)?.unixMilli);
    if (startMs == null || endMs == null || startMs % 1_000 !== 0 || endMs % 1_000 !== 0 || endMs < startMs) {
      return NO_VOLUME;
    }
    const startSec = startMs / 1_000;
    const endSec = endMs / 1_000;
    if (startSec < windowStartSec || endSec > effectiveWindowEndSec) continue;
    if (endSec - startSec !== HOUR_SECONDS || startSec % HOUR_SECONDS !== 0) return NO_VOLUME;
    const volume = asRecord(tick?.volume);
    const volumeAsset = asRecord(volume?.asset);
    const volumeAssetId = toRegistryAsset(volumeAsset?.id);
    const quantityStr = volume?.quantity;
    if (
      volumeAssetId !== assetA.id
      || volumeAsset?.decimals !== assetADecimals
      || typeof quantityStr !== "string"
      || !/^(?:0|[1-9]\d*)$/u.test(quantityStr)
    ) {
      return NO_VOLUME;
    }
    const qty = BigInt(quantityStr);
    const prev = qtyByStartSec.get(startSec);
    if (prev !== undefined) {
      if (prev !== qty) return NO_VOLUME;
      continue;
    }
    qtyByStartSec.set(startSec, qty);
  }
  if (qtyByStartSec.size === 0) return NO_VOLUME;
  let sumRawQty = 0n;
  for (const qty of qtyByStartSec.values()) sumRawQty += qty;
  const rawUnits = sumRawQty === 0n ? 0 : toTokenUnits(sumRawQty, assetADecimals);
  if (rawUnits == null) return NO_VOLUME;
  const volume24h = (rawUnits / legDivisor) * assetARef;
  if (!Number.isFinite(volume24h) || volume24h < 0 || !passesUsdVolumeSourcePreflight(tvlUsd, volume24h)) {
    return NO_VOLUME;
  }
  return { volume24h, volumeWindowEndSec: effectiveWindowEndSec };
}

/** Stages one pool; returns whether it counts as observed for the census. */
function stagePool(
  pool: SundaePool,
  trackedIndex: number,
  target: ContractDeployment,
  hasGraphqlErrors: boolean,
  context: CrawlStageContext,
  adaUsdRef: SundaeSwapAdaUsdReference | null,
): boolean {
  const valued = valuePool(pool, trackedIndex, target, context, adaUsdRef);
  const { tvlUsd, priceUsd } = valued.tvlUsd != null && valued.tvlUsd <= STAGED_POOL_MAX_TVL_USD ? valued : UNVALUED;
  // A valued pool under the retained-pool floor is a completed below-threshold
  // observation (as TzKT and Osmosis); an unvalued pool's size is unknown.
  if (tvlUsd != null && tvlUsd < DEX_LIQUIDITY_POOL_MIN_TVL_USD) return false;
  const poolId = canonicalExitRouteScopedKey(target.chain, pool.id);
  if (context.hasKnownPool(poolId)) return true;
  const { volume24h, volumeWindowEndSec } = valuePoolVolume24h(
    pool,
    trackedIndex,
    target,
    tvlUsd,
    hasGraphqlErrors,
    context,
    adaUsdRef,
  );
  const pair = pool.assets.length === 2;
  context.addPool(
    toStagedPool(context, {
      poolId,
      source: SUNDAESWAP,
      chain: target.chain,
      protocol: SUNDAESWAP,
      dexId: SUNDAESWAP,
      symbol: pool.assets.map((asset) => asset.ticker).join(" / "),
      tvlUsd,
      volume24h,
      qualityMultiplier: null,
      poolType: `sundaeswap-${pool.shape}`,
      feeTier: pool.feeBps,
      balanceRatio: null,
      isStable: pool.shape === "stableswap" || pool.shape === "constant-sum" ? true : null,
      baseToken: pair ? pool.assets[0]!.id : target.address,
      quoteToken: pair ? pool.assets[1]!.id : null,
      quoteSymbol: pair ? pool.assets[1]!.ticker : null,
      priceUsd,
      lockedLiqPct: null,
      rawJson: volumeWindowEndSec != null ? JSON.stringify({ sundaeswapVolumeWindowEndSec: volumeWindowEndSec }) : null,
    }),
  );
  return true;
}

async function stageTargetPools(
  body: unknown,
  target: ContractDeployment,
  context: CrawlStageContext,
  loadAdaUsdReference?: SundaeSwapAdaUsdLoader,
): Promise<SundaeSwapProviderCheck> {
  const root = asRecord(body);
  const byAsset = asRecord(asRecord(root?.data)?.pools)?.byAsset;
  if (!Array.isArray(byAsset)) {
    return { ...makeDexDeploymentProviderCheck(target, SUNDAESWAP, "degraded"), error: "sundaeswap-malformed-payload" };
  }
  const rows: unknown[] = byAsset;
  const hasGraphqlErrors = root?.errors != null;
  // GraphQL reports resolver errors beside partial data under HTTP 200, and a
  // full page is the silent row cap: neither is a complete answer.
  let error = hasGraphqlErrors ? "sundaeswap-graphql-errors"
    : rows.length >= SUNDAESWAP_BY_ASSET_ROW_CAP ? "sundaeswap-row-cap" : undefined;
  const parsedPools: Array<{ pool: SundaePool; trackedIndex: number }> = [];
  for (const row of rows) {
    const pool = parsePool(row);
    const trackedIndex = pool ? pool.assets.findIndex((asset) => asset.id === target.address) : -1;
    if (pool == null || trackedIndex < 0) {
      error ??= "sundaeswap-malformed-row";
      continue;
    }
    parsedPools.push({ pool, trackedIndex });
  }
  const hasAdaConstantProduct = parsedPools.some(({ pool, trackedIndex }) =>
    isAdaConstantProductPair(pool, trackedIndex));
  const adaLoad = hasAdaConstantProduct && loadAdaUsdReference != null
    ? await resolveAdaUsdReference(loadAdaUsdReference, context.nowSec)
    : null;
  const adaUsdRef = adaLoad?.reference ?? null;
  let observedPoolCount = 0;
  let adaValuationSkippedCount = 0;
  for (const { pool, trackedIndex } of parsedPools) {
    if (adaLoad != null && adaUsdRef == null && isAdaConstantProductPair(pool, trackedIndex)) {
      adaValuationSkippedCount += 1;
    }
    if (stagePool(pool, trackedIndex, target, hasGraphqlErrors, context, adaUsdRef)) observedPoolCount += 1;
  }
  const check = makeDexDeploymentProviderCheck(target, SUNDAESWAP, error ? "degraded" : "success", {
    observedPoolCount: error && observedPoolCount === 0 ? undefined : observedPoolCount,
  });
  return {
    ...check,
    ...(error ? { error } : {}),
    ...(adaValuationSkippedCount > 0 && adaLoad != null && adaLoad.status !== "ok"
      ? { adaValuationReason: `ada-usd-${adaLoad.status}` as const, adaValuationSkippedCount }
      : {}),
  };
}

/**
 * Supplemental Cardano census: one serial GraphQL read per tracked deployment,
 * bounded body, abort-covered consumption; the eight-second stage signal spans
 * both attempts. The breaker records one provider outcome per stage. Any failed
 * read (timeout, network error, non-2xx status, unparseable or over-cap body)
 * counts against it and stops further requests this stage, unless the coin
 * deadline ended the read. A readable answer with bad rows degrades that
 * deployment's check instead.
 */
export async function crawlSundaeSwapPoolsStage(input: {
  db: D1Database;
  coinTargets: ContractDeployment[];
  context: CrawlStageContext;
  loadAdaUsdReference?: SundaeSwapAdaUsdLoader;
}): Promise<SundaeSwapPoolsStageResult> {
  const targets = input.coinTargets.filter(({ chain, address }) => isSundaeSwapDiscoveryDeployment(chain, address));
  if (targets.length === 0) return { providerChecks: [] };
  if (input.context.timeExceeded()) return { providerChecks: [], stoppedEarly: true };
  if (!(await shouldAttemptFetch(input.db, CIRCUIT_SOURCE.SUNDAESWAP_DISCOVERY))) return { providerChecks: [] };

  const floorHourSec = Math.floor(input.context.nowSec / HOUR_SECONDS) * HOUR_SECONDS;
  const tickWindowStart = formatSundaeUtc(floorHourSec - 25 * HOUR_SECONDS);
  const tickWindowEnd = formatSundaeUtc(floorHourSec);

  const providerChecks: DexDeploymentProviderCheck[] = [];
  let stoppedEarly = false;
  let transportFailed = false;
  for (const target of targets) {
    if (input.context.timeExceeded()) {
      stoppedEarly = true;
      break;
    }
    const result = await fetchDexDiscoveryJsonEndpoint({
      url: SUNDAESWAP_GRAPHQL_URL,
      body: JSON.stringify({
        query: SUNDAESWAP_POOLS_QUERY,
        variables: {
          asset: `${target.address.slice(0, 56)}.${target.address.slice(56)}`,
          start: tickWindowStart,
          end: tickWindowEnd,
        },
      }),
      signal: input.context.buildStageSignal(SUNDAESWAP_TIMEOUT_MS),
      maxRetries: SUNDAESWAP_MAX_RETRIES,
      maxResponseBytes: SUNDAESWAP_MAX_RESPONSE_BYTES,
      timeoutMs: SUNDAESWAP_TIMEOUT_MS,
    });
    if (input.context.signal?.aborted) throw input.context.signal.reason;
    if (result.kind === "failure") {
      if (input.context.timeExceeded()) {
        // The coin deadline ended the read, not the provider.
        stoppedEarly = true;
        break;
      }
      transportFailed = true;
      providerChecks.push(makeDexDeploymentProviderCheck(target, SUNDAESWAP, "failure", { retryable: result.retryable }));
      break;
    }
    providerChecks.push(await stageTargetPools(result.body, target, input.context, input.loadAdaUsdReference));
  }
  if (providerChecks.length > 0) {
    await recordOutcomeSafe(input.db, CIRCUIT_SOURCE.SUNDAESWAP_DISCOVERY, !transportFailed);
  }
  return { providerChecks, stoppedEarly };
}
