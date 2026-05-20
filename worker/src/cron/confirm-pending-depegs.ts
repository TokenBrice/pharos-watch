import {
  getDepegThresholdBps,
  DEPEG_PENDING_MIN_AGE_SEC,
  DEPEG_PENDING_EXPIRY_SEC,
  DEPEG_SECONDARY_THRESHOLD_RATIO,
  DEFILLAMA_COINS,
  USER_AGENT,
  CIRCUIT_SOURCE,
  DEX_FRESHNESS_SEC,
  DEPEG_DEX_PROTOCOL_CORROBORATION_MIN,
  DEPEG_PRIMARY_PRICE_MAX_AGE_SEC,
  POOL_CHALLENGE_MIN_TVL,
  POOL_CHALLENGE_CONFIRM_MIN,
  POOL_CHALLENGE_HIGH_TVL_USD,
} from "../lib/constants";
import { CoinGeckoSimplePriceSchema, DefiLlamaCoinsPriceSchema } from "../lib/upstream-schemas";
import { batchExecute } from "../lib/db";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { fetchWithRetry } from "../lib/fetch-retry";
import { cancelResponseBodyQuietly } from "../lib/response-body";
import { cgUrl, cgHeaders } from "../lib/coingecko";
import { throwIfAborted } from "../lib/abort";
import { recordOutcomeSafe, shouldAttemptFetch } from "../lib/circuit-breaker";
import { fetchBinancePricesDetailed } from "../lib/cex-tickers";
import { isSuccessfulOutcome } from "../lib/fetcher-result";
import type { PricingProviderAttemptDiagnostic } from "../lib/pricing-provider-diagnostics";
import {
  buildInsertDepegEventStmt,
  collectDexProtocolCorroborations,
  dexPoolIndependentGroupKey,
  loadDexPriceRows,
  loadDexPriceSources,
  loadDexPoolChallengers,
  isExtremeMovePending,
  parsePendingReason,
} from "../lib/depeg-helpers";
import {
  chooseIndependentOffchainDepegConfirmer,
  classifyPrimaryDepegTrust,
  isTrustedDexPriceRow,
  type OffchainDepegConfirmerKey,
} from "../lib/depeg-trust-policy";
import { fetchCurrentNativePegQuotes, normalizeSupportedPegCurrency } from "../lib/native-peg-quotes";
import {
  classifyDirectionalSignal,
  deriveDepegSignal,
  pickMoreSevereBps,
  type DepegSignal,
} from "../lib/depeg-signals";
import {
  normalizePendingDepegRow,
  type PendingDepegRow,
  type PendingDepegState,
  SELECT_PENDING_DEPEGS_SQL,
} from "../lib/depeg-pending";
import type { DepegEvent } from "@shared/types/market";
import type { PegAssetBase } from "@shared/types/core";
import { derivePegRates, getPegReference } from "@shared/lib/peg-rates";

const CONFIRMATION_TIMESTAMP_FUTURE_SKEW_SEC = 5 * 60;
const DEPEG_PENDING_EXTENDED_EXPIRY_SEC = DEPEG_PENDING_EXPIRY_SEC * 3;
const DEPEG_PENDING_SEVERE_EXPIRY_SEC = DEPEG_PENDING_EXPIRY_SEC * 4;

type DirectionalSignalStatus = ReturnType<typeof classifyDirectionalSignal>;
type ConfirmationTimestampStatus = "fresh" | "missing" | "invalid" | "future" | "stale";
type PendingOutcome = "promoted" | "rejected" | "expired" | "recovered" | "superseded" | "unconfirmed-severe";

interface PeakCandidate {
  bps: number | null | undefined;
  price: number | null | undefined;
}

interface PendingOutcomeEvidence {
  confirmingSources?: string[];
  opposingSources?: string[];
  unavailableSources?: string[];
  circuitOpenSources?: string[];
}

function classifyConfirmationTimestamp(timestamp: number | null | undefined, nowSec: number): ConfirmationTimestampStatus {
  if (timestamp == null) return "missing";
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "invalid";
  if (timestamp - nowSec > CONFIRMATION_TIMESTAMP_FUTURE_SKEW_SEC) return "future";
  if (nowSec - timestamp > DEPEG_PRIMARY_PRICE_MAX_AGE_SEC) return "stale";
  return "fresh";
}

function pickPeakCandidate(candidates: PeakCandidate[], fallback: PeakCandidate): { bps: number; price: number | null } {
  const peakBps = pickMoreSevereBps(...candidates.map((candidate) => candidate.bps)) ?? fallback.bps ?? 0;
  const matching = candidates.find((candidate) => candidate.bps === peakBps && candidate.price != null);
  return {
    bps: peakBps,
    price: matching?.price ?? fallback.price ?? null,
  };
}

function confirmationSourceList(...groups: Array<Array<string | null | undefined> | string | null | undefined>): string {
  const keys: string[] = [];
  for (const group of groups) {
    const values = Array.isArray(group) ? group : [group];
    for (const value of values) {
      if (value && !keys.includes(value)) keys.push(value);
    }
  }
  return keys.join("+");
}

function addSource(target: string[], source: string | null | undefined): void {
  if (source && !target.includes(source)) target.push(source);
}

function addSources(target: string[], sources: Iterable<string | null | undefined>): void {
  for (const source of sources) addSource(target, source);
}

function buildPendingOutcomeStmt(
  db: D1Database,
  row: PendingDepegRow,
  state: PendingDepegState,
  outcome: PendingOutcome,
  outcomeAt: number,
  evidence: PendingOutcomeEvidence,
  finalDecisionReason: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO depeg_pending_outcomes (
         pending_id,
         stablecoin_id,
         symbol,
         peg_type,
         direction,
         reason,
         first_seen_bps,
         first_seen_at,
         first_price,
         last_seen_bps,
         last_seen_at,
         last_price,
         peak_seen_bps,
         peak_price,
         peg_reference,
         outcome,
         outcome_at,
         confirming_sources,
         opposing_sources,
         unavailable_sources,
         circuit_open_sources,
         final_decision_reason,
         created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id ?? null,
      row.stablecoin_id,
      row.symbol,
      row.peg_type,
      state.direction,
      state.reason,
      state.firstSeenBps,
      state.firstSeenAt,
      state.firstPrice,
      state.lastSeenBps,
      state.lastSeenAt,
      state.lastPrice,
      state.peakSeenBps,
      state.peakPrice,
      state.pegReference,
      outcome,
      outcomeAt,
      confirmationSourceList(evidence.confirmingSources ?? []) || null,
      confirmationSourceList(evidence.opposingSources ?? []) || null,
      confirmationSourceList(evidence.unavailableSources ?? []) || null,
      confirmationSourceList(evidence.circuitOpenSources ?? []) || null,
      finalDecisionReason,
      outcomeAt,
    );
}

function buildDeletePendingStmt(db: D1Database, row: PendingDepegRow): D1PreparedStatement {
  return db.prepare("DELETE FROM depeg_pending WHERE id = ?").bind(row.id);
}

function buildOutcomeAndDeleteStmts(
  db: D1Database,
  row: PendingDepegRow,
  state: PendingDepegState,
  outcome: PendingOutcome,
  outcomeAt: number,
  evidence: PendingOutcomeEvidence,
  finalDecisionReason: string,
): D1PreparedStatement[] {
  return [
    buildPendingOutcomeStmt(db, row, state, outcome, outcomeAt, evidence, finalDecisionReason),
    buildDeletePendingStmt(db, row),
  ];
}

function isOpposingConfirmationStatus(status: DirectionalSignalStatus): boolean {
  return status === "recover" || status === "contradict";
}

function buildNativeConfirmationKey(pegCurrency: string | null | undefined): string {
  return `native:${(pegCurrency ?? "native").toLowerCase()}`;
}

function buildDexConfirmationKeys(protocolKeys: string[]): string[] {
  return protocolKeys.map((key) => `dex:${key}`);
}

function buildPoolConfirmationKey(pool: { protocol: string; sourceFamily?: string }): string {
  return `pool:${dexPoolIndependentGroupKey(pool)}`;
}

function buildPoolGroupKey(groupKey: string): string {
  return `pool:${groupKey}`;
}

function expectsNativePegQuote(meta: ReturnType<typeof ACTIVE_META_BY_ID.get>): boolean {
  return (
    typeof meta?.geckoId === "string" &&
    meta.geckoId.length > 0 &&
    normalizeSupportedPegCurrency(meta.flags.pegCurrency) != null
  );
}

function getPendingExpiryLimitSec(params: {
  primarySameDirectionDepegged: boolean;
  isExtremeMove: boolean;
  unavailableSources: string[];
  circuitOpenSources: string[];
}): number {
  let expirySec = DEPEG_PENDING_EXPIRY_SEC;
  if (
    params.primarySameDirectionDepegged ||
    params.unavailableSources.length > 0 ||
    params.circuitOpenSources.length > 0
  ) {
    expirySec = Math.max(expirySec, DEPEG_PENDING_EXTENDED_EXPIRY_SEC);
  }
  if (params.isExtremeMove) {
    expirySec = Math.max(expirySec, DEPEG_PENDING_SEVERE_EXPIRY_SEC);
  }
  return expirySec;
}

type OffchainUnavailableReason =
  | "non-ok"
  | "empty-response"
  | "upstream-error"
  | `${ConfirmationTimestampStatus}-timestamp`;

type OffchainConfirmerResult =
  | { kind: "no-confirmer" }
  | { kind: "circuit-open"; sourceKey: OffchainDepegConfirmerKey }
  | {
      kind: "classified";
      sourceKey: OffchainDepegConfirmerKey;
      status: DirectionalSignalStatus;
      signal: DepegSignal | null;
      price: number;
    }
  | { kind: "unavailable"; sourceKey: OffchainDepegConfirmerKey; reason: OffchainUnavailableReason };

async function evaluateOffchainConfirmer(args: {
  db: D1Database;
  symbol: string;
  geckoId: string;
  pegReference: number;
  secondaryBar: number;
  direction: PendingDepegState["direction"];
  agreeSources: string[] | undefined;
  priceSource: string | null | undefined;
  defillamaAllowed: boolean;
  coingeckoAllowed: boolean;
  coingeckoApiKey: string | null | undefined;
  signal: AbortSignal | undefined;
  now: number;
}): Promise<OffchainConfirmerResult> {
  const {
    db,
    symbol,
    geckoId,
    pegReference,
    secondaryBar,
    direction,
    agreeSources,
    priceSource,
    defillamaAllowed,
    coingeckoAllowed,
    coingeckoApiKey,
    signal,
    now,
  } = args;
  const confirmerKey = chooseIndependentOffchainDepegConfirmer({ agreeSources, priceSource });
  if (confirmerKey == null) {
    console.log(
      `[depeg-confirm] ${symbol} off-chain skipped: primary agreement already includes CoinGecko and DefiLlama families`,
    );
    return { kind: "no-confirmer" };
  }

  const useDefiLlamaSecondary = confirmerKey === "defillama-confirm";
  const offchainLabel = useDefiLlamaSecondary ? "DefiLlama" : "CoinGecko";
  const circuitKey = useDefiLlamaSecondary
    ? CIRCUIT_SOURCE.DEFILLAMA_CONFIRM
    : CIRCUIT_SOURCE.COINGECKO_CONFIRM;
  const offchainAllowed = useDefiLlamaSecondary ? defillamaAllowed : coingeckoAllowed;
  if (!offchainAllowed) {
    console.log(`[depeg-confirm] ${symbol} ${offchainLabel} skipped: circuit open`);
    return { kind: "circuit-open", sourceKey: confirmerKey };
  }

  try {
    const offchainRes = await fetchWithRetry(
      useDefiLlamaSecondary
        ? `${DEFILLAMA_COINS}/prices/current/coingecko:${geckoId}`
        : cgUrl(`/simple/price?ids=${geckoId}&vs_currencies=usd&include_last_updated_at=true`, coingeckoApiKey ?? null),
      useDefiLlamaSecondary
        ? { headers: { "User-Agent": USER_AGENT }, signal }
        : {
            headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }, coingeckoApiKey ?? null),
            signal,
          },
      1, // single retry
    );
    if (!offchainRes?.ok) {
      await cancelResponseBodyQuietly(offchainRes);
      await recordOutcomeSafe(db, circuitKey, false);
      return { kind: "unavailable", sourceKey: confirmerKey, reason: "non-ok" };
    }

    let offchainPrice: number | undefined;
    let observedAt: number | undefined;
    if (useDefiLlamaSecondary) {
      const parsed = DefiLlamaCoinsPriceSchema.safeParse(await offchainRes.json());
      const coin = parsed.success ? parsed.data.coins?.[`coingecko:${geckoId}`] : undefined;
      offchainPrice = coin?.price;
      observedAt = coin?.timestamp;
    } else {
      const parsed = CoinGeckoSimplePriceSchema.safeParse(await offchainRes.json());
      const coin = parsed.success ? parsed.data[geckoId] : undefined;
      offchainPrice = coin?.usd;
      observedAt = coin?.last_updated_at;
    }

    const timestampStatus = classifyConfirmationTimestamp(observedAt, now);
    if (offchainPrice && offchainPrice > 0 && timestampStatus === "fresh") {
      const offchainSignal = deriveDepegSignal(offchainPrice, pegReference);
      const status = classifyDirectionalSignal(offchainSignal, secondaryBar, direction);
      console.log(
        `[depeg-confirm] ${symbol} ${offchainLabel} check: price=$${offchainPrice}, deviation=${offchainSignal?.absBps ?? "n/a"}bps, ` +
        `bar=${secondaryBar}bps, status=${status}`
      );
      await recordOutcomeSafe(db, circuitKey, true);
      return { kind: "classified", sourceKey: confirmerKey, status, signal: offchainSignal, price: offchainPrice };
    }
    if (offchainPrice && offchainPrice > 0) {
      console.log(
        `[depeg-confirm] ${symbol} ${offchainLabel} skipped ${timestampStatus} timestamp=${observedAt ?? "missing"}`,
      );
      await recordOutcomeSafe(db, circuitKey, true);
      return {
        kind: "unavailable",
        sourceKey: confirmerKey,
        reason: `${timestampStatus}-timestamp` as OffchainUnavailableReason,
      };
    }
    await recordOutcomeSafe(db, circuitKey, true);
    return { kind: "unavailable", sourceKey: confirmerKey, reason: "empty-response" };
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    await recordOutcomeSafe(db, circuitKey, false);
    console.warn(`[depeg-confirm] ${offchainLabel} fetch failed for ${symbol}:`, err);
    return { kind: "unavailable", sourceKey: confirmerKey, reason: "upstream-error" };
  }
}

/**
 * Process pending depeg records that require secondary confirmation.
 * Called after detectDepegEvents() in each sync cycle.
 *
 * For each pending record:
 * 1. If primary price no longer exceeds threshold -> delete (transient noise)
 * 2. If too young (same cycle) -> skip (wait for next cycle)
 * 3. Fetch CoinGecko spot price and read DEX median
 * 4. If primary + secondary agree -> promote to real event
 * 5. If primary above but both secondary disagree -> delete (false positive)
 * 6. If no secondary data available -> keep (retry next cycle)
 * 7. If pending > 45 min without promotion -> delete (expired)
 */
export async function confirmPendingDepegs(
  db: D1Database,
  assets: PegAssetBase[],
  fxFallbackRates?: Record<string, number>,
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
): Promise<{ providerDiagnostics: PricingProviderAttemptDiagnostic[] }> {
  throwIfAborted(signal);
  const providerDiagnostics: PricingProviderAttemptDiagnostic[] = [];
  const pending = await db
    .prepare(SELECT_PENDING_DEPEGS_SQL)
    .all<PendingDepegRow>();

  const rows = pending.results ?? [];
  if (rows.length === 0) return { providerDiagnostics };

  const now = Math.floor(Date.now() / 1000);
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const nativePegQuotes = await fetchCurrentNativePegQuotes(
    rows.map((row) => {
      const meta = ACTIVE_META_BY_ID.get(row.stablecoin_id);
      return {
        stablecoinId: row.stablecoin_id,
        geckoId: meta?.geckoId ?? null,
        pegCurrency: meta?.flags.pegCurrency ?? null,
      };
    }),
    signal,
    coingeckoApiKey,
  );

  // Compute peg rates for reference price lookups
  const { rates: pegRates } = derivePegRates(assets, ACTIVE_META_BY_ID, fxFallbackRates);

  // Load DEX prices
  throwIfAborted(signal);
  const dexPriceRows = await loadDexPriceRows(db);
  const dexPriceSources = await loadDexPriceSources(db, DEX_FRESHNESS_SEC);

  // Load individual pool prices for pool-level confirmation
  throwIfAborted(signal);
  const poolChallengers = await loadDexPoolChallengers(db, POOL_CHALLENGE_MIN_TVL, DEX_FRESHNESS_SEC, now);

  // Check for existing open events to avoid duplicates
  throwIfAborted(signal);
  const openEvents = await db
    .prepare("SELECT stablecoin_id FROM depeg_events WHERE ended_at IS NULL")
    .all<{ stablecoin_id: string }>();
  const openSet = new Set((openEvents.results ?? []).map((r) => r.stablecoin_id));

  let cexPrices: Map<string, number> | null = null;
  const cexAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.BINANCE_PRICES);
  if (cexAllowed) {
    throwIfAborted(signal);
    try {
      const outcome = await fetchBinancePricesDetailed(signal);
      const { prices, diagnostics } = outcome.value;
      for (const diagnostic of diagnostics) {
        diagnostic.stage = "depeg-confirmation";
      }
      providerDiagnostics.push(...diagnostics);
      cexPrices = prices;
      await recordOutcomeSafe(db, CIRCUIT_SOURCE.BINANCE_PRICES, isSuccessfulOutcome(outcome));
    } catch (err) {
      if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
      await recordOutcomeSafe(db, CIRCUIT_SOURCE.BINANCE_PRICES, false);
      cexPrices = null;
    }
  }

  // Pre-flight circuit-breaker checks: evaluate once instead of per pending row.
  const [coingeckoAllowed, defillamaAllowed] = await Promise.all([
    shouldAttemptFetch(db, CIRCUIT_SOURCE.COINGECKO_CONFIRM),
    shouldAttemptFetch(db, CIRCUIT_SOURCE.DEFILLAMA_CONFIRM),
  ]);

  // Collect all mutation statements and execute as a batch at the end
  const stmts: D1PreparedStatement[] = [];

  for (const row of rows) {
    throwIfAborted(signal);
    const pendingState = normalizePendingDepegRow(row);
    const asset = assetById.get(row.stablecoin_id);
    const meta = ACTIVE_META_BY_ID.get(row.stablecoin_id);
    const refreshedPegRef =
      asset && meta
        ? getPegReference(asset.pegType, pegRates, meta.commodityOunces)
        : Number.NaN;
    const pegReference =
      Number.isFinite(refreshedPegRef) && refreshedPegRef > 0
        ? refreshedPegRef
        : row.peg_reference;
    const outcomeState: PendingDepegState = { ...pendingState, pegReference };
    // Guard: peg_reference is used as divisor below — delete if neither the
    // current reference nor the pending-row snapshot is usable.
    if (!Number.isFinite(pegReference) || pegReference <= 0) {
      stmts.push(
        ...buildOutcomeAndDeleteStmts(
          db,
          row,
          outcomeState,
          "rejected",
          now,
          {},
          `invalid-peg-reference:${row.peg_reference}`,
        ),
      );
      console.warn(`[depeg-confirm] Deleted pending for ${row.symbol}: invalid peg_reference=${row.peg_reference}`);
      continue;
    }

    const threshold = getDepegThresholdBps(row.peg_type);
    const secondaryBar = Math.round(threshold * DEPEG_SECONDARY_THRESHOLD_RATIO);
    const primaryTrust = asset ? classifyPrimaryDepegTrust(asset, now) : "unusable";
    const nativePegQuote = nativePegQuotes.get(row.stablecoin_id);
    const nativeSignal = nativePegQuote ? deriveDepegSignal(nativePegQuote.price, 1) : null;
    const nativeThresholdStatus = classifyDirectionalSignal(nativeSignal, threshold, pendingState.direction);
    const nativePegRecovered = nativeThresholdStatus === "recover";
    const nativePegStillDepegged = nativeThresholdStatus === "confirm";
    const confirmingSources: string[] = [];
    const opposingSources: string[] = [];
    const unavailableSources: string[] = [];
    const circuitOpenSources: string[] = [];
    const hardOpposingSources: string[] = [];
    const nativeSourceKey = buildNativeConfirmationKey(nativePegQuote?.pegCurrency ?? meta?.flags.pegCurrency);
    if (nativeSignal != null) {
      if (nativeThresholdStatus === "confirm") addSource(confirmingSources, nativeSourceKey);
      if (isOpposingConfirmationStatus(nativeThresholdStatus)) {
        addSource(opposingSources, nativeSourceKey);
        addSource(hardOpposingSources, nativeSourceKey);
      }
    } else if (expectsNativePegQuote(meta)) {
      addSource(unavailableSources, buildNativeConfirmationKey(meta?.flags.pegCurrency));
    }

    const authoritativePrice =
      asset != null &&
      primaryTrust === "authoritative" &&
      asset.price != null &&
      typeof asset.price === "number" &&
      Number.isFinite(asset.price) &&
      asset.price > 0
        ? asset.price
        : null;
    const currentPrimarySignal =
      authoritativePrice != null
        ? deriveDepegSignal(authoritativePrice, pegReference)
        : null;
    const currentPrimaryStatus = classifyDirectionalSignal(currentPrimarySignal, threshold, pendingState.direction);
    const primarySameDirectionDepegged = currentPrimaryStatus === "confirm";

    // If an open event was created by another path (e.g. direction change), clean up pending
    if (openSet.has(row.stablecoin_id)) {
      stmts.push(
        ...buildOutcomeAndDeleteStmts(
          db,
          row,
          outcomeState,
          "superseded",
          now,
          { confirmingSources, opposingSources, unavailableSources, circuitOpenSources },
          "open-event-already-exists",
        ),
      );
      console.log(`[depeg-confirm] Cleaned pending for ${row.symbol}: open event already exists`);
      continue;
    }

    if (nativePegRecovered) {
      stmts.push(
        ...buildOutcomeAndDeleteStmts(
          db,
          row,
          outcomeState,
          "recovered",
          now,
          { confirmingSources, opposingSources, unavailableSources, circuitOpenSources },
          "native-peg-recovered",
        ),
      );
      console.log(
        `[depeg-confirm] Cleared pending for ${row.symbol}: direct ${nativePegQuote?.pegCurrency ?? meta?.flags.pegCurrency ?? "native"} quote recovered to ${nativeSignal?.absBps ?? "n/a"}bps`,
      );
      continue;
    }

    // 1. Check if primary price still exceeds threshold
    if (currentPrimaryStatus === "recover" && !nativePegStillDepegged) {
      addSource(opposingSources, "primary:authoritative");
      stmts.push(
        ...buildOutcomeAndDeleteStmts(
          db,
          row,
          outcomeState,
          "recovered",
          now,
          { confirmingSources, opposingSources, unavailableSources, circuitOpenSources },
          "authoritative-primary-recovered",
        ),
      );
      console.log(
        `[depeg-confirm] Cleared pending for ${row.symbol}: authoritative primary recovered to ${currentPrimarySignal?.absBps ?? "n/a"}bps`,
      );
      continue;
    }

    // 2. Check age -- skip if too young (same cycle)
    const age = now - pendingState.firstSeenAt;
    if (age < DEPEG_PENDING_MIN_AGE_SEC) {
      continue; // Wait for next cycle
    }

    // 3. Fetch independent off-chain spot price
    let offchainStatus: DirectionalSignalStatus = "insufficient";
    let offchainSourceKey: string | null = null;
    let offchainPeakCandidate: PeakCandidate | null = null;
    const geckoId = meta?.geckoId;
    if (nativeSignal != null) {
      offchainStatus = classifyDirectionalSignal(nativeSignal, secondaryBar, pendingState.direction);
      offchainSourceKey = nativeSourceKey;
      if (offchainStatus === "confirm") {
        offchainPeakCandidate = { bps: nativeSignal.bps, price: nativePegQuote?.price ?? null };
        addSource(confirmingSources, offchainSourceKey);
      } else if (isOpposingConfirmationStatus(offchainStatus)) {
        addSource(opposingSources, offchainSourceKey);
        addSource(hardOpposingSources, offchainSourceKey);
      }
      console.log(
        `[depeg-confirm] ${row.symbol} direct ${nativePegQuote?.pegCurrency ?? meta?.flags.pegCurrency ?? "native"} check: ` +
        `price=${nativePegQuote?.price ?? "n/a"}, deviation=${nativeSignal.absBps}bps, ` +
        `bar=${secondaryBar}bps, status=${offchainStatus}`,
      );
    } else if (geckoId) {
      const result = await evaluateOffchainConfirmer({
        db,
        symbol: row.symbol,
        geckoId,
        pegReference,
        secondaryBar,
        direction: pendingState.direction,
        agreeSources: asset?.agreeSources,
        priceSource: asset?.priceSource,
        defillamaAllowed,
        coingeckoAllowed,
        coingeckoApiKey,
        signal,
        now,
      });
      switch (result.kind) {
        case "no-confirmer":
          break;
        case "circuit-open":
          addSource(circuitOpenSources, result.sourceKey);
          break;
        case "unavailable":
          addSource(unavailableSources, `${result.sourceKey}:${result.reason}`);
          break;
        case "classified":
          offchainStatus = result.status;
          offchainSourceKey = result.sourceKey;
          if (result.status === "confirm") {
            offchainPeakCandidate = { bps: result.signal?.bps, price: result.price };
            addSource(confirmingSources, result.sourceKey);
          } else if (isOpposingConfirmationStatus(result.status)) {
            addSource(opposingSources, result.sourceKey);
          }
          break;
      }
    }

    // 4. Read DEX median
    let dexStatus: DirectionalSignalStatus = "insufficient";
    let dexPeakCandidates: PeakCandidate[] = [];
    let dexConfirmationKeys: string[] = [];
    const dexRow = dexPriceRows.get(row.stablecoin_id);
    if (dexRow != null && isTrustedDexPriceRow(dexRow, now, "depeg")) {
      const dexSignal = deriveDepegSignal(dexRow.dex_price_usd, pegReference);
      const aggregateDexStatus = classifyDirectionalSignal(dexSignal, secondaryBar, pendingState.direction);
      const protocolSources = dexPriceSources.get(row.stablecoin_id);
      const confirmGroups = collectDexProtocolCorroborations(
        protocolSources,
        pegReference,
        secondaryBar,
        pendingState.direction,
        "confirm",
      );
      const recoverGroups = collectDexProtocolCorroborations(
        protocolSources,
        pegReference,
        secondaryBar,
        pendingState.direction,
        "recover",
      );
      const contradictGroups = collectDexProtocolCorroborations(
        protocolSources,
        pegReference,
        secondaryBar,
        pendingState.direction,
        "contradict",
      );
      if (aggregateDexStatus === "confirm" && confirmGroups.length >= DEPEG_DEX_PROTOCOL_CORROBORATION_MIN) {
        dexStatus = "confirm";
        dexConfirmationKeys = buildDexConfirmationKeys(confirmGroups.map((group) => group.key));
        addSources(confirmingSources, dexConfirmationKeys);
        dexPeakCandidates = [
          { bps: dexSignal?.bps, price: dexRow.dex_price_usd },
          ...confirmGroups.map((group) => ({ bps: group.signal.bps, price: group.source.price })),
        ];
      } else if (aggregateDexStatus === "recover" && recoverGroups.length >= DEPEG_DEX_PROTOCOL_CORROBORATION_MIN) {
        dexStatus = "recover";
        const keys = buildDexConfirmationKeys(recoverGroups.map((group) => group.key));
        addSources(opposingSources, keys);
        addSources(hardOpposingSources, keys);
      } else if (aggregateDexStatus === "contradict" && contradictGroups.length >= DEPEG_DEX_PROTOCOL_CORROBORATION_MIN) {
        dexStatus = "contradict";
        const keys = buildDexConfirmationKeys(contradictGroups.map((group) => group.key));
        addSources(opposingSources, keys);
        addSources(hardOpposingSources, keys);
      }
      console.log(
        `[depeg-confirm] ${row.symbol} DEX check: price=$${dexRow.dex_price_usd}, deviation=${dexSignal?.absBps ?? "n/a"}bps, ` +
        `bar=${secondaryBar}bps, aggregate=${aggregateDexStatus}, ` +
        `confirmGroups=${confirmGroups.length}, recoverGroups=${recoverGroups.length}, ` +
        `contradictGroups=${contradictGroups.length}, status=${dexStatus}`
      );
    } else if (dexRow != null) {
      addSource(unavailableSources, "dex:aggregate-untrusted");
    } else {
      addSource(unavailableSources, "dex:aggregate");
    }

    // 4b. CEX ticker check
    let cexStatus: DirectionalSignalStatus = "insufficient";
    let cexPeakCandidate: PeakCandidate | null = null;
    if (!cexAllowed) {
      addSource(circuitOpenSources, "cex:binance");
    } else if (cexPrices == null) {
      addSource(unavailableSources, "cex:binance");
    } else {
      const cexPrice = cexPrices.get(row.symbol.toUpperCase());
      if (cexPrice && cexPrice > 0) {
        const cexSignal = deriveDepegSignal(cexPrice, pegReference);
        cexStatus = classifyDirectionalSignal(cexSignal, secondaryBar, pendingState.direction);
        if (cexStatus === "confirm") {
          cexPeakCandidate = { bps: cexSignal?.bps, price: cexPrice };
          addSource(confirmingSources, "cex:binance");
        } else if (isOpposingConfirmationStatus(cexStatus)) {
          addSource(opposingSources, "cex:binance");
          addSource(hardOpposingSources, "cex:binance");
        }
        console.log(
          `[depeg-confirm] ${row.symbol} CEX check: price=$${cexPrice}, deviation=${cexSignal?.absBps ?? "n/a"}bps, ` +
          `bar=${secondaryBar}bps, status=${cexStatus}`,
        );
      }
    }

    // 4c. Individual DEX pool check
    let poolStatus: DirectionalSignalStatus = "insufficient";
    const poolConfirmGroups = new Map<string, { key: string; pool: { price: number; tvlUsd: number; protocol: string; sourceFamily?: string }; signal: DepegSignal }>();
    const poolContradictGroups = new Set<string>();
    const poolRecoverGroups = new Set<string>();
    let poolHighTvlConfirm: { key: string; pool: { price: number; tvlUsd: number; protocol: string; sourceFamily?: string }; signal: DepegSignal } | null = null;
    const pools = poolChallengers.get(row.stablecoin_id);
    if (pools?.length) {
      for (const pool of pools) {
        const poolSignal = deriveDepegSignal(pool.price, pegReference);
        if (poolSignal == null) continue;
        const poolGroupKey = dexPoolIndependentGroupKey(pool);
        const currentPoolStatus = classifyDirectionalSignal(poolSignal, secondaryBar, pendingState.direction);
        if (currentPoolStatus === "confirm") {
          const existing = poolConfirmGroups.get(poolGroupKey);
          const candidate = { key: poolGroupKey, pool, signal: poolSignal };
          if (existing == null || poolSignal.absBps > existing.signal.absBps) {
            poolConfirmGroups.set(poolGroupKey, candidate);
          }
          if (pool.tvlUsd >= POOL_CHALLENGE_HIGH_TVL_USD) {
            if (poolHighTvlConfirm == null || pool.tvlUsd > poolHighTvlConfirm.pool.tvlUsd) {
              poolHighTvlConfirm = candidate;
            }
          }
          console.log(
            `[depeg-confirm] ${row.symbol} pool confirm: price=$${pool.price} (${pool.protocol}/${pool.chain}, ` +
            `$${(pool.tvlUsd / 1e6).toFixed(1)}M TVL), deviation=${poolSignal?.absBps ?? "n/a"}bps`,
          );
        } else if (currentPoolStatus === "contradict") {
          poolContradictGroups.add(poolGroupKey);
        } else if (currentPoolStatus === "recover") {
          poolRecoverGroups.add(poolGroupKey);
        }
      }
      // Priority ladder: confirm > contradict > recover > insufficient.
      // Tie-break: any confirm below the promotion bar cancels both contradict
      // and recover (treated as mixed evidence -> insufficient).
      if (poolHighTvlConfirm != null || poolConfirmGroups.size >= POOL_CHALLENGE_CONFIRM_MIN) {
        poolStatus = "confirm";
        addSources(
          confirmingSources,
          (poolHighTvlConfirm != null ? [poolHighTvlConfirm] : [...poolConfirmGroups.values()])
            .map((confirmation) => buildPoolConfirmationKey(confirmation.pool)),
        );
      } else if (poolContradictGroups.size > 0 && poolConfirmGroups.size === 0) {
        poolStatus = "contradict";
        const keys = [...poolContradictGroups].map(buildPoolGroupKey);
        addSources(opposingSources, keys);
        addSources(hardOpposingSources, keys);
      } else if (poolRecoverGroups.size > 0 && poolConfirmGroups.size === 0 && poolContradictGroups.size === 0) {
        poolStatus = "recover";
        const keys = [...poolRecoverGroups].map(buildPoolGroupKey);
        addSources(opposingSources, keys);
        addSources(hardOpposingSources, keys);
      }
      console.log(
        `[depeg-confirm] ${row.symbol} pool summary: ${pools.length} pools checked, ` +
        `confirmGroups=${poolConfirmGroups.size} (highTvl=${poolHighTvlConfirm != null}), ` +
        `contradictGroups=${poolContradictGroups.size}, recoverGroups=${poolRecoverGroups.size}, ` +
        `bar=${secondaryBar}bps, status=${poolStatus}`,
      );
    } else {
      addSource(unavailableSources, "pool:challenger");
    }

    // 5. Decision
    // For "low-confidence" pending events, the off-chain check alone is not
    // sufficient for promotion because the primary (CG/DL) and secondary
    // (DL→CG or CG) sources often share the same underlying data, making the
    // confirmation circular rather than independent.  Require at least one
    // hard secondary source (DEX, CEX, or individual pool) to promote.
    const hasHardConfirmation =
      dexStatus === "confirm" ||
      cexStatus === "confirm" ||
      poolStatus === "confirm";
    if (hasHardConfirmation || (offchainStatus === "confirm" && !parsePendingReason(pendingState.reason).has("low-confidence"))) {
      // At least one secondary source confirms -- promote to real event (INSERT + DELETE atomically)
      const currentSignal =
        authoritativePrice != null
          ? deriveDepegSignal(authoritativePrice, pegReference)
          : null;
      const currentDirectionalSignal =
        classifyDirectionalSignal(currentSignal, threshold, pendingState.direction) === "confirm"
          ? currentSignal
          : null;
      const poolConfirmations =
        dexStatus === "confirm"
          ? []
          : poolHighTvlConfirm != null
            ? [poolHighTvlConfirm]
            : [...poolConfirmGroups.values()];
      const peak = pickPeakCandidate(
        [
          { bps: pendingState.peakSeenBps, price: pendingState.peakPrice },
          { bps: currentDirectionalSignal?.bps, price: authoritativePrice },
          ...(offchainPeakCandidate ? [offchainPeakCandidate] : []),
          ...(cexPeakCandidate ? [cexPeakCandidate] : []),
          ...dexPeakCandidates,
          ...poolConfirmations.map((confirmation) => ({
            bps: confirmation.signal.bps,
            price: confirmation.pool.price,
          })),
        ],
        { bps: pendingState.peakSeenBps, price: pendingState.peakPrice },
      );
      const confirmedBy = confirmationSourceList(
        offchainStatus === "confirm" ? offchainSourceKey : null,
        dexStatus === "confirm" ? dexConfirmationKeys : [],
        cexStatus === "confirm" ? "cex:binance" : null,
        poolStatus === "confirm"
          ? poolConfirmations.map((confirmation) => buildPoolConfirmationKey(confirmation.pool))
          : [],
      );
      const event: DepegEvent = {
        id: 0,
        stablecoinId: row.stablecoin_id,
        symbol: row.symbol,
        pegType: row.peg_type,
        direction: pendingState.direction,
        peakDeviationBps: peak.bps,
        startedAt: pendingState.firstSeenAt,
        endedAt: null,
        startPrice: pendingState.firstPrice,
        peakPrice: peak.price,
        recoveryPrice: null,
        pegReference,
        source: "live",
        confirmationSources: confirmedBy || null,
        pendingReason: pendingState.reason,
      };

      stmts.push(
        buildInsertDepegEventStmt(db, event),
        buildPendingOutcomeStmt(
          db,
          row,
          outcomeState,
          "promoted",
          now,
          { confirmingSources, opposingSources, unavailableSources, circuitOpenSources },
          `confirmed-by:${confirmedBy || "unknown"}`,
        ),
        buildDeletePendingStmt(db, row),
      );

      console.log(
        `[depeg-confirm] PROMOTED ${row.symbol}: ${pendingState.firstSeenBps}bps confirmed by ${confirmedBy || "(none)"}${pendingState.reason ? ` (${pendingState.reason})` : ""}`
      );
    } else {
      const statuses = [offchainStatus, dexStatus, cexStatus, poolStatus];
      const hasSameDirectionConfirmation = statuses.includes("confirm");
      const hasOpposingEvidence = statuses.some(isOpposingConfirmationStatus);
      const canRejectOpposingEvidence =
        hasOpposingEvidence &&
        !hasSameDirectionConfirmation &&
        (!primarySameDirectionDepegged || hardOpposingSources.length >= 2);
      const isExpired = age > DEPEG_PENDING_EXPIRY_SEC;
      const expiryLimitSec = getPendingExpiryLimitSec({
        primarySameDirectionDepegged,
        isExtremeMove: isExtremeMovePending(pendingState.reason),
        unavailableSources,
        circuitOpenSources,
      });
      const finalExpiryExceeded = age > expiryLimitSec;

      // Available secondary evidence points away from the pending direction and
      // no same-direction source rescues it.
      if (canRejectOpposingEvidence) {
        const reason = primarySameDirectionDepegged
          ? `two-hard-opposing-sources:${confirmationSourceList(hardOpposingSources)}`
          : "secondary-evidence-opposes";
        stmts.push(
          ...buildOutcomeAndDeleteStmts(
            db,
            row,
            outcomeState,
            "rejected",
            now,
            { confirmingSources, opposingSources, unavailableSources, circuitOpenSources },
            reason,
          ),
        );
        console.log(
          `[depeg-confirm] Rejected ${row.symbol}: secondary evidence opposes pending direction ` +
          `(offchain=${offchainStatus}, dex=${dexStatus}, cex=${cexStatus}, pool=${poolStatus})`,
        );
      } else if (isExpired && finalExpiryExceeded) {
        const severe = isExtremeMovePending(pendingState.reason);
        stmts.push(
          ...buildOutcomeAndDeleteStmts(
            db,
            row,
            outcomeState,
            severe ? "unconfirmed-severe" : "expired",
            now,
            { confirmingSources, opposingSources, unavailableSources, circuitOpenSources },
            `expired-after:${age}s;limit:${expiryLimitSec}s`,
          ),
        );
        console.log(
          `[depeg-confirm] Expired pending for ${row.symbol}: ${Math.round(age / 60)}min without confirmation ` +
          `(limit ${Math.round(expiryLimitSec / 60)}min)`,
        );
      } else if (isExpired) {
        console.log(
          `[depeg-confirm] Kept pending for ${row.symbol} past base expiry: ` +
          `age=${Math.round(age / 60)}min, limit=${Math.round(expiryLimitSec / 60)}min, ` +
          `primarySameDirection=${primarySameDirectionDepegged}, unavailable=${confirmationSourceList(unavailableSources) || "none"}, ` +
          `circuitOpen=${confirmationSourceList(circuitOpenSources) || "none"}`,
        );
      }
    }
    // else: insufficient secondary data or mixed evidence -- keep pending and retry next cycle
  }

  // Execute all collected mutations atomically
  if (stmts.length > 0) {
    throwIfAborted(signal);
    await batchExecute(db, stmts);
    console.log(`[depeg-confirm] Executed ${stmts.length} pending depeg mutations`);
  }

  return { providerDiagnostics };
}
