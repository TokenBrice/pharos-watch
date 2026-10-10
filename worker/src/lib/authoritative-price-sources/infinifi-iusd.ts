import { logWorkerEventArgs } from "../structured-log";
import { fetchEvmCallHexAtBlock } from "../evm-rpc";
import { getPublicFallbackRpcUrls } from "../public-rpc-registry";
import type { ChainRpcConfig } from "../chain-registry";
import {
  decodeUint256WordBigInt,
  encodeUint256,
  ETHEREUM_CHAIN,
  getUsdcQuotedRedeemConfig,
  ratioToNumber,
  USDC_CIRCLE_ID,
} from "./helpers";
import { createProtocolRedeemProvider } from "./protocol-redeem-provider";

const IUSD_INFINIFI_ID = "iusd-infinifi";
const IUSD_RECEIPT_TO_ASSET_SELECTOR = "0xf308cf65"; // receiptToAsset(uint256)
const IUSD_INFINIFI_REDEEM_CONTROLLER = "0xCb1747E89a43DEdcF4A2b831a0D94859EFeC7601";

async function fetchInfiniFiRedeemQuote(
  blockNumberOrTag: number | "latest",
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<number | null> {
  const config = getUsdcQuotedRedeemConfig(IUSD_INFINIFI_ID);
  if (!config) return null;

  const inputAmount = 10n ** BigInt(config.contractDecimals);
  const quoteHex = await fetchEvmCallHexAtBlock(
    ETHEREUM_CHAIN,
    IUSD_INFINIFI_REDEEM_CONTROLLER,
    `${IUSD_RECEIPT_TO_ASSET_SELECTOR}${encodeUint256(inputAmount)}`,
    blockNumberOrTag,
    {
      signal,
      extraRpcUrls: getPublicFallbackRpcUrls(ETHEREUM_CHAIN),
      chainRpcs,
    },
  );
  if (!quoteHex) {
    logWorkerEventArgs("lib", "warn", `[authoritative-price-sources] iusd-infinifi: RPC returned null`);
    return null;
  }

  const outputAmount = decodeUint256WordBigInt(quoteHex, 0);
  if (outputAmount == null || outputAmount <= 0n) {
    logWorkerEventArgs("lib", "warn", `[authoritative-price-sources] iusd-infinifi: contract returned zero or invalid output`);
    return null;
  }

  const quoteUnitsPerToken = ratioToNumber(outputAmount, config.quoteDecimals, inputAmount, config.contractDecimals);
  return Number.isFinite(quoteUnitsPerToken) && quoteUnitsPerToken > 0 ? quoteUnitsPerToken : null;
}

export const iusdInfinifiProvider = createProtocolRedeemProvider({
  stablecoinId: IUSD_INFINIFI_ID,
  parentId: USDC_CIRCLE_ID,
  async fetchLiveQuote(_asset, context, signal): Promise<number | null> {
    return fetchInfiniFiRedeemQuote("latest", signal, context.chainRpcs);
  },
  async fetchHistoricalQuote(_context, blockNumber, _timestamp, signal): Promise<number | null> {
    return fetchInfiniFiRedeemQuote(blockNumber, signal);
  },
});
