import type { AlchemyLogEntry } from "../alchemy-logs";
import { decodeAddress, decodeUint256AtSlot, readDataWord } from "../evm-logs";
import type { MintBurnContractConfig, MintBurnEventDef } from "../mint-burn-contracts";
import { findMintBurnHistoricalPrice } from "./context";
import type { MintBurnPriceHistoryPoint, MintBurnRow } from "./types";

interface EventPriceResolution {
  price: number | null;
  priceTimestamp: number | null;
  priceSource: string | null;
}

function resolveEventPrice(
  stablecoinId: string,
  timestamp: number,
  prices: Map<string, number>,
  priceHistory: Map<string, MintBurnPriceHistoryPoint[]>,
  runTimestamp: number,
): EventPriceResolution {
  const historical = findMintBurnHistoricalPrice(priceHistory, stablecoinId, timestamp);
  if (historical?.price != null) {
    return {
      price: historical.price,
      priceTimestamp: historical.snapshotDate,
      priceSource: "supply-history-daily",
    };
  }

  const current = prices.get(stablecoinId);
  if (current != null) {
    return {
      price: current,
      priceTimestamp: runTimestamp,
      priceSource: "price-cache-current",
    };
  }

  return { price: null, priceTimestamp: null, priceSource: null };
}

export function parseMintBurnLogs(
  config: MintBurnContractConfig,
  eventDef: MintBurnEventDef,
  logs: AlchemyLogEntry[],
  blockTimestamps: Map<number, number>,
  prices: Map<string, number>,
  priceHistory: Map<string, MintBurnPriceHistoryPoint[]>,
  runTimestamp: number,
): { rows: MintBurnRow[]; dropped: number } {
  const rows: MintBurnRow[] = [];
  const direction = eventDef.direction;
  let dropped = 0;

  for (const log of logs) {
    const slot = eventDef.amountEncoding === "nth-data-uint256" ? (eventDef.dataSlot ?? 0) : 0;
    const amount = decodeUint256AtSlot(log.data, slot, config.decimals);
    if (amount <= 0 || amount < config.dustThreshold) {
      dropped++;
      continue;
    }

    const blockNum = parseInt(log.blockNumber, 16);
    const logIndex = parseInt(log.logIndex, 16);
    const timestamp = blockTimestamps.get(blockNum) ?? 0;
    if (isNaN(blockNum) || !timestamp) {
      dropped++;
      continue;
    }

    const id = `${config.chain.chainId}-${log.transactionHash}-${logIndex}`;
    let counterparty: string | null = null;
    if (eventDef.counterpartyEncoding) {
      const enc = eventDef.counterpartyEncoding;
      if (enc.source === "topic") {
        const word = log.topics[enc.index];
        counterparty = word ? decodeAddress(word) : null;
      } else {
        const word = readDataWord(log.data, enc.slot);
        counterparty = word ? decodeAddress(word) : null;
      }
    } else {
      const counterpartyTopic = direction === "mint" ? log.topics[2] : log.topics[1];
      counterparty = counterpartyTopic ? decodeAddress(counterpartyTopic) : null;
    }

    const eventPrice = resolveEventPrice(
      config.stablecoinId,
      timestamp,
      prices,
      priceHistory,
      runTimestamp,
    );
    const amountUsd = eventPrice.price != null ? amount * eventPrice.price : null;

    rows.push({
      id,
      stablecoin_id: config.stablecoinId,
      symbol: config.symbol,
      chain_id: config.chain.chainId,
      direction,
      amount,
      amount_usd: amountUsd,
      price_used: eventPrice.price,
      price_timestamp: eventPrice.priceTimestamp,
      price_source: eventPrice.priceSource,
      burn_type: direction === "burn" ? "effective_burn" : null,
      burn_review_reason: null,
      flow_type: "standard",
      counterparty,
      tx_hash: log.transactionHash,
      block_number: blockNum,
      timestamp,
      explorer_tx_url: `${config.chain.explorerUrl}/tx/${log.transactionHash}`,
    });
  }

  return { rows, dropped };
}
