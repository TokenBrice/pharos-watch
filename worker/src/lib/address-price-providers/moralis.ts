import type {
  AddressPriceProviderRuntimeConfig,
  AddressPriceProviderRunResult,
  AddressPriceTarget,
} from "./types";
import { throwIfAborted } from "../abort";
import { applyInvalidShapeDiagnostic } from "../pricing-provider-lifecycle";
import { numberValue, stringValue } from "@shared/lib/type-guards";
import {
  ADDRESS_PROVIDER_MIN_LIQUIDITY_USD,
  chunk,
  createAddressProviderRunner,
  emptyProviderResult,
  fetchProviderJson,
  getTokenAddressFromRecord,
  groupTargetsByProviderChain,
  incrementReason,
  isRecord,
  narrowMetadata,
  parseNonNegativeNumber,
  parsePositiveNumber,
} from "./shared";

const MORALIS_ADDRESS_BATCH_SIZE = 100;
const MORALIS_ADDRESS_MAX_REQUESTS = 3;

export async function runMoralisAddressProvider(
  targets: AddressPriceTarget[],
  config: AddressPriceProviderRuntimeConfig,
  signal: AbortSignal | undefined,
  nowSec: number,
  deadlineMs: number,
): Promise<AddressPriceProviderRunResult> {
  const apiKey = config.moralisApiKey?.trim();
  if (!apiKey) return emptyProviderResult("moralis-address", targets, "missing-provider");
  const runner = createAddressProviderRunner({
    provider: "moralis-address",
    label: "Moralis",
    targets,
    deadlineMs,
    maxRequests: MORALIS_ADDRESS_MAX_REQUESTS,
  });
  const { quotes, rejectedTargets } = runner;

  for (const [providerChainId, chainTargets] of groupTargetsByProviderChain(targets)) {
    throwIfAborted(signal);
    for (const batch of chunk(chainTargets, MORALIS_ADDRESS_BATCH_SIZE)) {
      throwIfAborted(signal);
      if (!runner.canStartRequest()) break;
      runner.beginRequest();
      const url = `https://deep-index.moralis.io/api/v2.2/erc20/prices?chain=${encodeURIComponent(providerChainId)}`;
      const { json, diagnostic: rawDiagnostic } = await fetchProviderJson({
        provider: "moralis-address",
        url,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": apiKey,
          },
          body: JSON.stringify({
            tokens: batch.map((target) => ({ token_address: target.address })),
          }),
        },
        candidateCount: batch.length,
        targets: batch,
        signal,
      });
      let diagnostic = rawDiagnostic;
      const rows = Array.isArray(json)
        ? json
        : isRecord(json) && Array.isArray(json.result)
          ? json.result
          : isRecord(json) && Array.isArray(json.data)
            ? json.data
            : null;
      if (rows) {
        const matchedCountBefore = quotes.length;
        const targetByAddress = new Map(batch.map((target) => [target.address.toLowerCase(), target]));
        for (const row of rows) {
          if (!isRecord(row)) continue;
          const address = getTokenAddressFromRecord(row);
          if (!address) continue;
          const target = targetByAddress.get(address.toLowerCase());
          if (!target) continue;
          const priceUsd = parsePositiveNumber(row.usdPrice ?? row.usd_price);
          const liquidityUsd = parseNonNegativeNumber(row.pairTotalLiquidityUsd ?? row.liquidityUsd);
          if (!priceUsd) {
            incrementReason(rejectedTargets, "missing-quote");
            continue;
          }
          if (row.possibleSpam === true) {
            incrementReason(rejectedTargets, "price-rejected");
            continue;
          }
          if (liquidityUsd != null && liquidityUsd < ADDRESS_PROVIDER_MIN_LIQUIDITY_USD) {
            incrementReason(rejectedTargets, "price-rejected");
            continue;
          }
          quotes.push({
            stablecoinId: target.stablecoinId,
            source: "moralis-address",
            chain: target.chain,
            address: target.address,
            priceUsd,
            observedAt: nowSec,
            observedAtMode: "local_fetch",
            ...(liquidityUsd != null ? { liquidityUsd } : {}),
            metadata: {
              providerChainId,
              ...narrowMetadata({
                exchangeName: stringValue(row.exchangeName),
                exchangeAddress: stringValue(row.exchangeAddress),
                pairAddress: stringValue(row.pairAddress),
                verifiedContract: typeof row.verifiedContract === "boolean" ? row.verifiedContract : null,
                securityScore: numberValue(row.securityScore),
              }),
            },
          });
        }
        diagnostic.responseRowCount = rows.length;
        diagnostic.matchedCount = quotes.length - matchedCountBefore;
        diagnostic.success = true;
        runner.recordSuccess();
      } else if (json != null) {
        diagnostic = applyInvalidShapeDiagnostic(diagnostic, "Expected Moralis token price array");
      }
      runner.markProcessed(batch);
      runner.recordDiagnostic(diagnostic);
    }
  }

  return runner.finish();
}
