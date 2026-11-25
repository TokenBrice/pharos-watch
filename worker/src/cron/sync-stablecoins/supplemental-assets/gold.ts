import { logWorkerEvent, logWorkerEventArgs } from "../../../lib/structured-log";
import { isKinesisWrapperSupplyId } from "@shared/lib/onchain-supply-probe";
import { isKinesisWrapperSupplyCutoverActive } from "@shared/lib/supply-perimeter-changes";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { isDedicatedSingleTokenGoldProtocolSlug } from "@shared/lib/commodity-protocols";
import { fetchJsonWithRetry, fetchTextWithRetry } from "../../../lib/fetch-retry";
import { CIRCUIT_SOURCE, DEFILLAMA_API, USER_AGENT } from "../../../lib/constants";
import { throwIfAborted } from "../../../lib/abort";
import { recordOutcomeSafe, shouldAttemptFetch } from "../../../lib/circuit-breaker";
import { hasRegistryRpc, type ChainRpcConfig } from "../../../lib/chain-registry";
import { fetchEvmBlockHeader, fetchEvmUint256AtBlock } from "../../../lib/evm-rpc";
import { DECIMALS_SELECTOR, encodeBalanceOfCallData, TOTAL_SUPPLY_SELECTOR } from "../../../lib/evm-selectors";
import { parseXautTransparencyDisclosure } from "../../../lib/safety-score-v9/xaut-supply-observer";
import {
  buildXautTransparencySource, xautCirculatingLiabilityReconciles, XAUT_ASSET_ID, XAUT_CANONICAL_CHAIN_ID,
  XAUT_CANONICAL_TOKEN_ADDRESS, XAUT_DISCLOSURE_MAX_AGE_SEC, XAUT_SUPPLY_ATTRIBUTION_MAX_AGE_SEC,
  XAUT_SUPPLY_DISCLOSURE_MAX_AGE_SEC, XAUT_TREASURY_ADDRESS,
} from "../../../lib/safety-score-v9/xaut-supply-attribution-contract";
import type { DwellirNativeCapability } from "../../../lib/dwellir-native";
import type { PeggedAsset } from "../enrich-prices";
import {
  admitCommodityValuation,
  fetchCommodityTokens,
  fetchSupplementalPriceData,
  resolveCuratedAggregateSupplementalSupply,
  resolveSupplementalCoinGeckoMcap,
  resolveSupplementalCoinGeckoPrice,
  resolveSupplementalPrice,
  toPositiveFiniteNumber,
  type CoinGeckoMcapData,
  type CommodityValuationEvidence,
  type SupplementalPriceResolution,
} from "./shared";

const GOLD_METAS = ACTIVE_STABLECOINS.filter((stablecoin) => stablecoin.flags.pegCurrency === "GOLD");

async function readXautSupply(price: SupplementalPriceResolution | null, chainRpcs?: Map<string, ChainRpcConfig>, signal?: AbortSignal) {
  const source = buildXautTransparencySource();
  if (price?.observedAt == null || !source || !hasRegistryRpc(chainRpcs?.get(XAUT_CANONICAL_CHAIN_ID))) return null;
  const options = { chainRpcs, signal: signal ?? AbortSignal.timeout(10_000), timeoutMs: 10_000 };
  try {
    // Workers rejects redirect: "error" before sending; manual keeps
    // redirects fail-closed via the helper's non-2xx body cleanup.
    const result = await fetchJsonWithRetry(source.url, { signal: options.signal, redirect: "manual" }, 0, {
      timeoutMs: options.timeoutMs, maxResponseBytes: 1_000_000,
    });
    const disclosure = result?.response.ok ? parseXautTransparencyDisclosure(result.body) : null;
    const now = Math.floor(Date.now() / 1000);
    const disclosureAgeSec = disclosure ? now - disclosure.sourceTimestampSec : null;
    if (!disclosure || disclosureAgeSec == null || disclosureAgeSec < 0 || disclosureAgeSec > XAUT_SUPPLY_DISCLOSURE_MAX_AGE_SEC ||
        BigInt(disclosure.quarantinedRaw) !== 0n || price.observedAt > now) return null;
    const block = await fetchEvmBlockHeader(XAUT_CANONICAL_CHAIN_ID, "finalized", options);
    if (!block || block.timestamp > now || now - block.timestamp > XAUT_SUPPLY_ATTRIBUTION_MAX_AGE_SEC ||
        Math.abs(block.timestamp - price.observedAt) > XAUT_SUPPLY_ATTRIBUTION_MAX_AGE_SEC) return null;
    const pinned = { ...options, stateBlockHash: block.hash };
    const decimals = await fetchEvmUint256AtBlock(XAUT_CANONICAL_CHAIN_ID, XAUT_CANONICAL_TOKEN_ADDRESS, DECIMALS_SELECTOR, block.number, pinned);
    if (decimals !== 6n) return null;
    const total = await fetchEvmUint256AtBlock(XAUT_CANONICAL_CHAIN_ID, XAUT_CANONICAL_TOKEN_ADDRESS, TOTAL_SUPPLY_SELECTOR, block.number, pinned);
    const treasury = await fetchEvmUint256AtBlock(XAUT_CANONICAL_CHAIN_ID, XAUT_CANONICAL_TOKEN_ADDRESS,
      encodeBalanceOfCallData(XAUT_TREASURY_ADDRESS), block.number, pinned);
    const confirmed = await fetchEvmBlockHeader(XAUT_CANONICAL_CHAIN_ID, block.number, options);
    if (confirmed?.number !== block.number || confirmed.hash !== block.hash || confirmed.timestamp !== block.timestamp || total == null || treasury == null ||
        !xautCirculatingLiabilityReconciles({ canonicalTotalSupplyRaw: total, treasuryBalanceRaw: treasury,
          disclosedTotalAuthorizedRaw: BigInt(disclosure.totalAuthorizedRaw), disclosedNotIssuedRaw: BigInt(disclosure.notIssuedRaw) })) return null;
    // The canonical amount includes bridged stock once, through its L1 lockbox.
    const circulatingNative = Number(total - treasury) / 1_000_000;
    const mcap = circulatingNative * price.price;
    if (!Number.isFinite(mcap) || mcap < 0) return null;
    if (disclosureAgeSec > XAUT_DISCLOSURE_MAX_AGE_SEC) {
      logWorkerEvent({
        scope: "handler",
        level: "warn",
        job: "sync-stablecoins",
        event: "xaut-disclosure-extended-age-admitted",
        message: "[gold] Admitted XAUT supply with disclosure older than 48h on exact finalized Ethereum match",
        metadata: {
          stablecoinId: XAUT_ASSET_ID,
          sourceTimestampSec: disclosure.sourceTimestampSec,
          disclosureAgeSec,
          maxDisclosureAgeSec: XAUT_SUPPLY_DISCLOSURE_MAX_AGE_SEC,
          blockTimestampSec: block.timestamp,
        },
      });
    }
    return {
      mcap, circulatingNative, supplySource: "onchain-circulating-supply", supplyObservedAt: block.timestamp,
      valuationPriceUsd: price.price, valuationObservedAtSec: price.observedAt,
    };
  } catch (error) {
    throwIfAborted(signal);
    logWorkerEventArgs("handler", "warn", "[gold] XAUT scoped supply read failed:", error);
    return null;
  }
}
// Only these DefiLlama protocol slugs represent one gold token; issuer or
// protocol umbrella slugs can report an aggregate mcap for multiple products.

export async function fetchGoldTokens(
  cgData: CoinGeckoMcapData,
  signal?: AbortSignal,
  db?: D1Database,
  chainRpcs?: Map<string, ChainRpcConfig>,
  dwellirNative?: DwellirNativeCapability,
  evidence?: CommodityValuationEvidence,
): Promise<PeggedAsset[]> {
  throwIfAborted(signal);
  const nowSec = Math.floor(Date.now() / 1000);
  try {
    const priceData = await fetchSupplementalPriceData(GOLD_METAS, "gold", signal, db);

    const mcapMap: Record<string, number> = {};
    const observedAtById: Record<string, number | undefined> = {};
    const mcapSourceById: Record<string, "defillama" | "coingecko-fallback"> = {};
    const tokensWithProtocol = GOLD_METAS.filter((token) =>
      token.id !== XAUT_ASSET_ID && token.protocolSlug && isDedicatedSingleTokenGoldProtocolSlug(token.protocolSlug),
    );
    const PROTOCOL_BATCH = 3;
    const protocolsAllowed = tokensWithProtocol.length > 0 && db
      ? await shouldAttemptFetch(db, CIRCUIT_SOURCE.DL_PROTOCOLS)
      : true;
    let protocolFetchAttempts = 0;
    let protocolFetchSuccesses = 0;

    if (!protocolsAllowed) {
      logWorkerEventArgs("handler", "warn", "[gold] DefiLlama protocols circuit open; using CoinGecko market-cap fallback when available");
    } else {
      for (let pi = 0; pi < tokensWithProtocol.length; pi += PROTOCOL_BATCH) {
        const batch = tokensWithProtocol.slice(pi, pi + PROTOCOL_BATCH);
        await Promise.all(batch.map(async (token) => {
          protocolFetchAttempts += 1;
          try {
            const result = await fetchTextWithRetry(
              `${DEFILLAMA_API}/protocol/${token.protocolSlug}`,
              {
                headers: { "User-Agent": USER_AGENT },
                signal,
              },
              2,
              { returnFinalResponse: true },
            );
            if (!result?.response.ok) {
              logWorkerEventArgs("handler", "warn", `[sync-stablecoins] Protocol fetch failed for ${token.protocolSlug}: ${result?.response.status ?? "no response"}`);
              return;
            }

            const data = JSON.parse(result.body) as { mcap?: unknown };
            const protocolMcap = toPositiveFiniteNumber(data.mcap);
            if (protocolMcap == null) {
              logWorkerEventArgs("handler", "warn", `[sync-stablecoins] Protocol mcap was malformed for ${token.protocolSlug}`);
              return;
            }
            protocolFetchSuccesses += 1;
            mcapMap[token.id] = protocolMcap;
            mcapSourceById[token.id] = "defillama";
          } catch (err) {
            if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
            logWorkerEventArgs("handler", "warn", `[sync-stablecoins] Protocol fetch failed for ${token.protocolSlug}:`, err);
          }
        }));
      }
      if (db && protocolFetchAttempts > 0) {
        await recordOutcomeSafe(db, CIRCUIT_SOURCE.DL_PROTOCOLS, protocolFetchSuccesses > 0);
      }
    }

    for (const token of GOLD_METAS) {
      if (token.id === XAUT_ASSET_ID || isKinesisWrapperSupplyCutoverActive(token.id, nowSec)) continue;
      if (mcapMap[token.id] != null && mcapMap[token.id] > 0) continue;
      const mcap = resolveSupplementalCoinGeckoMcap(cgData, token.geckoId);
      if (mcap != null) {
        mcapMap[token.id] = mcap;
        mcapSourceById[token.id] = "coingecko-fallback";
        observedAtById[token.id] = token.geckoId ? cgData[token.geckoId]?.last_updated_at : undefined;
      }
    }

    // Aggregate probes remain serial inside the shared commodity driver.
    return fetchCommodityTokens(GOLD_METAS, {
      logPrefix: "gold",
      priceData,
      cgData,
      resolveSupply: async (meta) => {
        if (meta.id === XAUT_ASSET_ID) {
          const quote = admitCommodityValuation(meta, resolveSupplementalPrice(priceData, cgData, meta.geckoId), evidence);
          const scoped = await readXautSupply(quote, chainRpcs, signal);
          if (scoped) return scoped;
          return {
            mcap: null,
            supplySource: "onchain-supply-withheld",
            circulatingNative: null,
            valuationPriceUsd: null,
            valuationObservedAtSec: null,
          };
        }
        const aggregate = await resolveCuratedAggregateSupplementalSupply(meta, priceData, cgData, chainRpcs, signal, dwellirNative, evidence);
        if (aggregate) return aggregate;
        if (isKinesisWrapperSupplyCutoverActive(meta.id, nowSec)) return { mcap: null, supplySource: "onchain-supply-withheld" };
        const mcap = mcapMap[meta.id] ?? null;
        const cgQuote = mcap != null && mcapSourceById[meta.id] === "coingecko-fallback" && !isKinesisWrapperSupplyId(meta.id)
          ? admitCommodityValuation(meta, resolveSupplementalCoinGeckoPrice(cgData, meta.geckoId), evidence) : null;
        const native = mcap != null && cgQuote && cgQuote.observedAt === observedAtById[meta.id] ? mcap / cgQuote.price : null;
        return {
          circulatingNative: Number.isFinite(native) ? native : null,
          valuationPriceUsd: Number.isFinite(native) ? cgQuote?.price : null,
          valuationObservedAtSec: Number.isFinite(native) ? cgQuote?.observedAt : null,
          mcap,
          supplySource: mcapSourceById[meta.id] ?? "coingecko-fallback",
          supplyObservedAt: observedAtById[meta.id],
        };
      },
    });
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    logWorkerEventArgs("handler", "error", "[gold] fetchGoldTokens failed:", err);
    return [];
  }
}
