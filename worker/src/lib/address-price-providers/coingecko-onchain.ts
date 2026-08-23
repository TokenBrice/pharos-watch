import { cgUrl, cgHeaders } from "../coingecko";
import { RATE_LIMITS } from "../rate-limit";
import { sleepWithSignal, throwIfAborted } from "../abort";
import { applyInvalidShapeDiagnostic } from "../pricing-provider-lifecycle";
import type { AddressPriceProviderRunResult, AddressPriceTarget } from "./types";
import {
  ADDRESS_PROVIDER_MIN_LIQUIDITY_USD,
  chunk,
  createAddressProviderRunner,
  fetchProviderJson,
  groupTargetsByProviderChain,
  incrementReason,
  isRecord,
  parseNonNegativeNumber,
  parsePositiveNumber,
} from "./shared";

const CG_ONCHAIN_ADDRESS_MAX_REQUESTS = 5;
const CG_ONCHAIN_ADDRESS_BATCH_SIZE = 30;

function buildRoundRobinNetworkBatches(
  targets: AddressPriceTarget[],
): Array<{ providerChainId: string; targets: AddressPriceTarget[] }> {
  const networks = [...groupTargetsByProviderChain(targets)].map(
    ([providerChainId, networkTargets]) => ({
      providerChainId,
      batches: chunk(networkTargets, CG_ONCHAIN_ADDRESS_BATCH_SIZE),
    }),
  );
  const batches: Array<{ providerChainId: string; targets: AddressPriceTarget[] }> = [];
  for (let batchIndex = 0; ; batchIndex += 1) {
    let foundBatch = false;
    for (const network of networks) {
      const batch = network.batches[batchIndex];
      if (!batch) continue;
      batches.push({ providerChainId: network.providerChainId, targets: batch });
      foundBatch = true;
    }
    if (!foundBatch) break;
  }
  return batches;
}

export async function runCoingeckoOnchainAddressProvider(
  targets: AddressPriceTarget[],
  apiKey: string | null,
  signal: AbortSignal | undefined,
  nowSec: number,
  deadlineMs: number,
): Promise<AddressPriceProviderRunResult> {
  const runner = createAddressProviderRunner({
    provider: "coingecko-onchain-address",
    label: "CoinGecko onchain",
    targets,
    deadlineMs,
    maxRequests: CG_ONCHAIN_ADDRESS_MAX_REQUESTS,
    includeProcessedTargets: true,
  });
  const { quotes, rejectedTargets } = runner;

  for (const { providerChainId, targets: batch } of buildRoundRobinNetworkBatches(targets)) {
    throwIfAborted(signal);
    if (!runner.canStartRequest()) break;
    if (runner.attemptedRequests > 0) {
      await sleepWithSignal(RATE_LIMITS.COINGECKO_ONCHAIN_MS, signal);
    }
    runner.beginRequest();
    const url = cgUrl(
      `/onchain/networks/${providerChainId}/tokens/multi/${batch.map((target) => target.address).join(",")}`,
      apiKey,
    );
    const { json, diagnostic: rawDiagnostic } = await fetchProviderJson({
      provider: "coingecko-onchain-address",
      url,
      candidateCount: batch.length,
      targets: batch,
      signal,
      init: { headers: cgHeaders({}, apiKey) },
    });
    let diagnostic = rawDiagnostic;
    const data = isRecord(json) && Array.isArray(json.data) ? json.data : null;
    if (data) {
      const matchedCountBefore = quotes.length;
      const byAddress = new Map<string, Record<string, unknown>>();
      for (const entry of data) {
        if (!isRecord(entry) || !isRecord(entry.attributes)) continue;
        const address = entry.attributes.address;
        if (typeof address !== "string") continue;
        byAddress.set(address.toLowerCase(), entry.attributes);
      }
      for (const target of batch) {
        const attrs = byAddress.get(target.address.toLowerCase());
        if (!attrs) {
          incrementReason(rejectedTargets, "missing-quote");
          continue;
        }
        const priceUsd = parsePositiveNumber(attrs.price_usd);
        if (!priceUsd) {
          incrementReason(rejectedTargets, "missing-quote");
          continue;
        }
        const liquidityUsd = parseNonNegativeNumber(attrs.total_reserve_in_usd);
        if (liquidityUsd != null && liquidityUsd < ADDRESS_PROVIDER_MIN_LIQUIDITY_USD) {
          incrementReason(rejectedTargets, "price-rejected");
          continue;
        }
        const volume = isRecord(attrs.volume_usd) ? parseNonNegativeNumber(attrs.volume_usd.h24) : null;
        quotes.push({
          stablecoinId: target.stablecoinId,
          source: "coingecko-onchain-address",
          chain: target.chain,
          address: target.address,
          priceUsd,
          observedAt: nowSec,
          observedAtMode: "local_fetch",
          ...(liquidityUsd != null ? { liquidityUsd } : {}),
          volume24hUsd: volume ?? undefined,
          metadata: { providerChainId },
        });
      }
      diagnostic.responseRowCount = data.length;
      diagnostic.matchedCount = quotes.length - matchedCountBefore;
      diagnostic.success = true;
      runner.recordSuccess();
    } else if (json != null) {
      diagnostic = applyInvalidShapeDiagnostic(diagnostic, "Expected CoinGecko onchain tokens/multi payload");
    }
    runner.markProcessed(batch);
    runner.recordDiagnostic(diagnostic);
  }
  return runner.finish();
}
