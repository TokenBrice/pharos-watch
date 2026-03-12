import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { PriceConfidence } from "@shared/types";
import { fetchWithRetry } from "../lib/fetch-retry";
import type { PeggedAsset } from "./enrich-prices";
import { fetchEvmCallHex, resolveCoinContractAddress } from "./reserve-adapters/evm";

const ETHEREUM_CHAIN = "ethereum";
const FALLBACK_ETH_RPC_URL = "https://ethereum-rpc.publicnode.com";

const CAP_CUSD_ID = "cusd-cap";
const USDC_CIRCLE_ID = "usdc-circle";
const CAP_GET_BURN_AMOUNT_SELECTOR = "0xb7c4a6bf"; // getBurnAmount(address,uint256)

const CAP_SAMPLE_SUPPLY_FRACTION = 0.01;
const CAP_SAMPLE_NOTIONAL_MIN_USD = 1_000;
const CAP_SAMPLE_NOTIONAL_MAX_USD = 1_000_000;

interface ProtocolPriceOverrideResult {
  price: number;
  source: string;
  confidence: PriceConfidence;
}

function sumCirculatingUsd(asset: Pick<PeggedAsset, "circulating">): number {
  const circulating = asset.circulating;
  if (!circulating || typeof circulating !== "object") return 0;
  return Object.values(circulating).reduce(
    (sum, value) => sum + (typeof value === "number" && Number.isFinite(value) ? value : 0),
    0,
  );
}

function encodeAddress(address: string): string {
  return address.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
}

function encodeUint256(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function decodeUint256Word(result: `0x${string}`, wordIndex = 0): bigint | null {
  const start = 2 + (wordIndex * 64);
  const end = start + 64;
  if (result.length < end) return null;

  const word = result.slice(start, end);
  try {
    return BigInt(`0x${word}`);
  } catch {
    return null;
  }
}

function ratioToNumber(
  outputAmount: bigint,
  outputDecimals: number,
  inputAmount: bigint,
  inputDecimals: number,
  precision = 8,
): number {
  if (inputAmount <= 0n) return NaN;

  const scale = 10n ** BigInt(precision);
  const numerator = outputAmount * (10n ** BigInt(inputDecimals)) * scale;
  const denominator = inputAmount * (10n ** BigInt(outputDecimals));
  if (denominator <= 0n) return NaN;

  return Number(numerator / denominator) / (10 ** precision);
}

async function fetchHexViaFallbackRpc(
  rpcUrl: string,
  to: string,
  data: string,
  signal?: AbortSignal,
): Promise<`0x${string}` | null> {
  const res = await fetchWithRetry(
    rpcUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to, data }, "latest"],
      }),
    },
    1,
    { timeoutMs: 10_000 },
  );

  if (!res?.ok) return null;

  const body = await res.json() as { result?: string; error?: { message?: string } };
  if (body.error || typeof body.result !== "string" || !body.result.startsWith("0x") || body.result === "0x") {
    return null;
  }

  return body.result as `0x${string}`;
}

async function fetchCapRedeemPrice(
  asset: PeggedAsset,
  signal?: AbortSignal,
): Promise<ProtocolPriceOverrideResult | null> {
  const capMeta = TRACKED_META_BY_ID.get(CAP_CUSD_ID);
  const usdcMeta = TRACKED_META_BY_ID.get(USDC_CIRCLE_ID);
  if (!capMeta || !usdcMeta) return null;

  const capContract = resolveCoinContractAddress(capMeta, ETHEREUM_CHAIN);
  const usdcContract = resolveCoinContractAddress(usdcMeta, ETHEREUM_CHAIN);
  const capDecimals = capMeta.contracts?.find((entry) => entry.chain === ETHEREUM_CHAIN)?.decimals ?? 18;
  const usdcDecimals = usdcMeta.contracts?.find((entry) => entry.chain === ETHEREUM_CHAIN)?.decimals ?? 6;

  if (!capContract || !usdcContract) return null;

  const supplyUsd = sumCirculatingUsd(asset);
  const sampleNotionalUsd = Math.max(
    CAP_SAMPLE_NOTIONAL_MIN_USD,
    Math.min(
      CAP_SAMPLE_NOTIONAL_MAX_USD,
      supplyUsd > 0 ? supplyUsd * CAP_SAMPLE_SUPPLY_FRACTION : CAP_SAMPLE_NOTIONAL_MAX_USD,
    ),
  );
  const sampleInputAmount = BigInt(Math.round(sampleNotionalUsd)) * (10n ** BigInt(capDecimals));

  if (sampleInputAmount <= 0n) return null;

  const calldata = `${CAP_GET_BURN_AMOUNT_SELECTOR}${encodeAddress(usdcContract)}${encodeUint256(sampleInputAmount)}`;
  const quoteHex =
    await fetchEvmCallHex(ETHEREUM_CHAIN, capContract, calldata, signal) ??
    await fetchHexViaFallbackRpc(FALLBACK_ETH_RPC_URL, capContract, calldata, signal);
  if (!quoteHex) return null;

  const outputAmount = decodeUint256Word(quoteHex, 0);
  if (outputAmount == null || outputAmount <= 0n) return null;

  const price = ratioToNumber(outputAmount, usdcDecimals, sampleInputAmount, capDecimals);
  if (!Number.isFinite(price) || price <= 0) return null;

  return {
    price,
    source: "protocol-redeem",
    confidence: "high",
  };
}

export async function fetchProtocolPriceOverrides(
  assets: PeggedAsset[],
  signal?: AbortSignal,
): Promise<Map<string, ProtocolPriceOverrideResult>> {
  const results = new Map<string, ProtocolPriceOverrideResult>();

  for (const asset of assets) {
    if (asset.id !== CAP_CUSD_ID) continue;

    try {
      const quote = await fetchCapRedeemPrice(asset, signal);
      if (quote) {
        results.set(asset.id, quote);
      }
    } catch (error) {
      console.warn(`[protocol-price-overrides] ${asset.id} override failed:`, error);
    }
  }

  return results;
}
