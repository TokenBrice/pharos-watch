import {
  CIRCUIT_SOURCE,
  DEPEG_DEX_PROTOCOL_CORROBORATION_MIN,
  POOL_CHALLENGE_CONFIRM_MIN,
  POOL_CHALLENGE_HIGH_TVL_USD,
  USER_AGENT,
} from "../lib/constants";
import { cgHeaders, cgSimplePricePath, cgUrl } from "../lib/coingecko";
import { recordOutcomeSafe } from "../lib/circuit-breaker";
import {
  collectDexProtocolCorroborations,
  dexPoolIndependentGroupKey,
  isNativeOriginPending,
} from "../lib/depeg-helpers";
import {
  chooseIndependentOffchainDepegConfirmer,
  isTrustedDexPriceRow,
  type OffchainDepegConfirmerKey,
} from "../lib/depeg-trust-policy";
import {
  classifyDirectionalSignal,
  deriveDepegSignal,
  type DepegSignal,
} from "../lib/depeg-signals";
import type { PendingDepegState } from "../lib/depeg-pending";
import { fetchJsonWithRetry } from "../lib/fetch-retry";
import { CoinGeckoSimplePriceSchema } from "../lib/upstream-schemas";
import {
  addSource,
  addSources,
  buildDexConfirmationKeys,
  buildPoolConfirmationKey,
  buildPoolGroupKey,
  classifyConfirmationTimestamp,
  isOpposingConfirmationStatus,
  type CollectedConfirmationEvidence,
  type ConfirmationEvidenceInput,
  type PoolConfirmation,
} from "./pending-depeg-confirmation";

type DirectionalSignalStatus = ReturnType<typeof classifyDirectionalSignal>;
type ConfirmationTimestampStatus = "fresh" | "missing" | "invalid" | "future" | "stale";

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
    coingeckoAllowed,
    coingeckoApiKey,
    signal,
    now,
  } = args;
  const confirmerKey = chooseIndependentOffchainDepegConfirmer({ agreeSources, priceSource });
  if (confirmerKey == null) {
    console.log(
      `[depeg-confirm] ${symbol} off-chain skipped: primary agreement already includes the CoinGecko family`,
    );
    return { kind: "no-confirmer" };
  }

  const offchainLabel = "CoinGecko";
  const circuitKey = CIRCUIT_SOURCE.COINGECKO_CONFIRM;
  if (!coingeckoAllowed) {
    console.log(`[depeg-confirm] ${symbol} ${offchainLabel} skipped: circuit open`);
    return { kind: "circuit-open", sourceKey: confirmerKey };
  }

  try {
    const offchainResult = await fetchJsonWithRetry<unknown>(
      cgUrl(cgSimplePricePath(`ids=${geckoId}&vs_currencies=usd&include_last_updated_at=true`), coingeckoApiKey ?? null),
      {
        headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }, coingeckoApiKey ?? null),
        signal,
      },
      1,
    );
    if (!offchainResult?.response.ok) {
      await recordOutcomeSafe(db, circuitKey, false);
      return { kind: "unavailable", sourceKey: confirmerKey, reason: "non-ok" };
    }

    const parsed = CoinGeckoSimplePriceSchema.safeParse(offchainResult.body);
    const coin = parsed.success ? parsed.data[geckoId] : undefined;
    const offchainPrice = coin?.usd;
    const observedAt = coin?.last_updated_at;

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

export async function collectConfirmationEvidence(
  args: ConfirmationEvidenceInput,
): Promise<CollectedConfirmationEvidence> {
  const {
    db,
    row,
    pendingState,
    asset,
    meta,
    pegReference,
    secondaryBar,
    nativeSignal,
    nativePegQuote,
    nativeSourceKey,
    dexPriceRows,
    dexPriceSources,
    poolChallengers,
    cexAllowed,
    cexPrices,
    coingeckoAllowed,
    coingeckoApiKey,
    signal,
    now,
  } = args;
  const evidence: CollectedConfirmationEvidence = {
    confirmingSources: [...args.evidence.confirmingSources],
    opposingSources: [...args.evidence.opposingSources],
    unavailableSources: [...args.evidence.unavailableSources],
    circuitOpenSources: [...args.evidence.circuitOpenSources],
    hardOpposingSources: [...args.evidence.hardOpposingSources],
    offchainStatus: args.evidence.offchainStatus,
    offchainSourceKey: args.evidence.offchainSourceKey,
    offchainPeakCandidate: args.evidence.offchainPeakCandidate,
    dexStatus: args.evidence.dexStatus,
    dexPeakCandidates: [...args.evidence.dexPeakCandidates],
    dexConfirmationKeys: [...args.evidence.dexConfirmationKeys],
    cexStatus: args.evidence.cexStatus,
    cexPeakCandidate: args.evidence.cexPeakCandidate,
    poolStatus: args.evidence.poolStatus,
    poolConfirmations: [...args.evidence.poolConfirmations],
  };

  const geckoId = meta?.geckoId;
  const isNativeOrigin = isNativeOriginPending(pendingState.reason);
  if (nativeSignal != null && !isNativeOrigin) {
    evidence.offchainStatus = classifyDirectionalSignal(nativeSignal, secondaryBar, pendingState.direction);
    evidence.offchainSourceKey = nativeSourceKey;
    if (evidence.offchainStatus === "confirm") {
      evidence.offchainPeakCandidate = { bps: nativeSignal.bps, price: nativePegQuote?.price ?? null };
      addSource(evidence.confirmingSources, nativeSourceKey);
    } else if (isOpposingConfirmationStatus(evidence.offchainStatus)) {
      addSource(evidence.opposingSources, nativeSourceKey);
      addSource(evidence.hardOpposingSources, nativeSourceKey);
    }
    console.log(
      `[depeg-confirm] ${row.symbol} ${nativePegQuote?.pegCurrency ?? meta?.flags.pegCurrency ?? "native"} check: ` +
      `price=${nativePegQuote?.price ?? "n/a"}, deviation=${nativeSignal.absBps}bps, ` +
      `bar=${secondaryBar}bps, status=${evidence.offchainStatus}`,
    );
  } else if (geckoId && !isNativeOrigin) {
    const result = await evaluateOffchainConfirmer({
      db,
      symbol: row.symbol,
      geckoId,
      pegReference,
      secondaryBar,
      direction: pendingState.direction,
      agreeSources: asset?.agreeSources,
      priceSource: asset?.priceSource,
      coingeckoAllowed,
      coingeckoApiKey,
      signal,
      now,
    });
    switch (result.kind) {
      case "no-confirmer":
        break;
      case "circuit-open":
        addSource(evidence.circuitOpenSources, result.sourceKey);
        break;
      case "unavailable":
        addSource(evidence.unavailableSources, `${result.sourceKey}:${result.reason}`);
        break;
      case "classified":
        evidence.offchainStatus = result.status;
        evidence.offchainSourceKey = result.sourceKey;
        if (result.status === "confirm") {
          evidence.offchainPeakCandidate = { bps: result.signal?.bps, price: result.price };
          addSource(evidence.confirmingSources, result.sourceKey);
        } else if (isOpposingConfirmationStatus(result.status)) {
          addSource(evidence.opposingSources, result.sourceKey);
        }
        break;
    }
  }

  const dexRow = dexPriceRows.get(row.stablecoin_id);
  if (isNativeOrigin) {
    addSource(evidence.unavailableSources, "dex:usd-native-origin");
  } else if (dexRow != null && isTrustedDexPriceRow(dexRow, now, "depeg")) {
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
      evidence.dexStatus = "confirm";
      evidence.dexConfirmationKeys = buildDexConfirmationKeys(confirmGroups.map((group) => group.key));
      addSources(evidence.confirmingSources, evidence.dexConfirmationKeys);
      evidence.dexPeakCandidates = [
        { bps: dexSignal?.bps, price: dexRow.dex_price_usd },
        ...confirmGroups.map((group) => ({ bps: group.signal.bps, price: group.source.price })),
      ];
    } else if (aggregateDexStatus === "recover" && recoverGroups.length >= DEPEG_DEX_PROTOCOL_CORROBORATION_MIN) {
      evidence.dexStatus = "recover";
      const keys = buildDexConfirmationKeys(recoverGroups.map((group) => group.key));
      addSources(evidence.opposingSources, keys);
      addSources(evidence.hardOpposingSources, keys);
    } else if (aggregateDexStatus === "contradict" && contradictGroups.length >= DEPEG_DEX_PROTOCOL_CORROBORATION_MIN) {
      evidence.dexStatus = "contradict";
      const keys = buildDexConfirmationKeys(contradictGroups.map((group) => group.key));
      addSources(evidence.opposingSources, keys);
      addSources(evidence.hardOpposingSources, keys);
    }
    console.log(
      `[depeg-confirm] ${row.symbol} DEX check: price=$${dexRow.dex_price_usd}, deviation=${dexSignal?.absBps ?? "n/a"}bps, ` +
      `bar=${secondaryBar}bps, aggregate=${aggregateDexStatus}, ` +
      `confirmGroups=${confirmGroups.length}, recoverGroups=${recoverGroups.length}, ` +
      `contradictGroups=${contradictGroups.length}, status=${evidence.dexStatus}`
    );
  } else if (dexRow != null) {
    addSource(evidence.unavailableSources, "dex:aggregate-untrusted");
  } else {
    addSource(evidence.unavailableSources, "dex:aggregate");
  }

  if (isNativeOrigin) {
    addSource(evidence.unavailableSources, "cex:usd-native-origin");
  } else if (!cexAllowed) {
    addSource(evidence.circuitOpenSources, "cex:binance");
  } else if (cexPrices == null) {
    addSource(evidence.unavailableSources, "cex:binance");
  } else {
    const cexPrice = cexPrices.get(row.symbol.toUpperCase());
    if (cexPrice && cexPrice > 0) {
      const cexSignal = deriveDepegSignal(cexPrice, pegReference);
      evidence.cexStatus = classifyDirectionalSignal(cexSignal, secondaryBar, pendingState.direction);
      if (evidence.cexStatus === "confirm") {
        evidence.cexPeakCandidate = { bps: cexSignal?.bps, price: cexPrice };
        addSource(evidence.confirmingSources, "cex:binance");
      } else if (isOpposingConfirmationStatus(evidence.cexStatus)) {
        addSource(evidence.opposingSources, "cex:binance");
        addSource(evidence.hardOpposingSources, "cex:binance");
      }
      console.log(
        `[depeg-confirm] ${row.symbol} CEX check: price=$${cexPrice}, deviation=${cexSignal?.absBps ?? "n/a"}bps, ` +
        `bar=${secondaryBar}bps, status=${evidence.cexStatus}`,
      );
    }
  }

  const poolConfirmGroups = new Map<string, PoolConfirmation>();
  const poolContradictGroups = new Set<string>();
  const poolRecoverGroups = new Set<string>();
  let poolHighTvlConfirm: PoolConfirmation | null = null;
  const pools = poolChallengers.get(row.stablecoin_id);
  if (isNativeOrigin) {
    addSource(evidence.unavailableSources, "pool:usd-native-origin");
  } else if (pools?.length) {
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
    if (poolHighTvlConfirm != null || poolConfirmGroups.size >= POOL_CHALLENGE_CONFIRM_MIN) {
      evidence.poolStatus = "confirm";
      addSources(
        evidence.confirmingSources,
        (poolHighTvlConfirm != null ? [poolHighTvlConfirm] : [...poolConfirmGroups.values()])
          .map((confirmation) => buildPoolConfirmationKey(confirmation.pool)),
      );
    } else if (poolContradictGroups.size > 0 && poolConfirmGroups.size === 0) {
      evidence.poolStatus = "contradict";
      const keys = [...poolContradictGroups].map(buildPoolGroupKey);
      addSources(evidence.opposingSources, keys);
      addSources(evidence.hardOpposingSources, keys);
    } else if (poolRecoverGroups.size > 0 && poolConfirmGroups.size === 0 && poolContradictGroups.size === 0) {
      evidence.poolStatus = "recover";
      const keys = [...poolRecoverGroups].map(buildPoolGroupKey);
      addSources(evidence.opposingSources, keys);
      addSources(evidence.hardOpposingSources, keys);
    }
    console.log(
      `[depeg-confirm] ${row.symbol} pool summary: ${pools.length} pools checked, ` +
      `confirmGroups=${poolConfirmGroups.size} (highTvl=${poolHighTvlConfirm != null}), ` +
      `contradictGroups=${poolContradictGroups.size}, recoverGroups=${poolRecoverGroups.size}, ` +
      `bar=${secondaryBar}bps, status=${evidence.poolStatus}`,
    );
  } else {
    addSource(evidence.unavailableSources, "pool:challenger");
  }

  evidence.poolConfirmations =
    evidence.dexStatus === "confirm"
      ? []
      : poolHighTvlConfirm != null
        ? [poolHighTvlConfirm]
        : [...poolConfirmGroups.values()];

  return evidence;
}
