import type { AlchemyLogEntry } from "../alchemy-logs";
import { decodeAddress, decodeUint256AtSlotOrNull, readDataWord } from "../evm-logs";
import type { MintBurnContractConfig, MintBurnEventDef } from "../mint-burn-contracts";
import { resolveMintBurnEventPrice } from "./context";
import type { MintBurnPriceContext, MintBurnRow } from "./types";

const PARSE_PRICE_SOURCE_BY_EVIDENCE = {
  "supply-history": "supply-history-daily",
  "price-cache": "price-cache-event-window",
} as const;

export function parseMintBurnLogs(
  config: MintBurnContractConfig,
  eventDef: MintBurnEventDef,
  logs: AlchemyLogEntry[],
  blockTimestamps: Map<number, number>,
  priceContext: MintBurnPriceContext,
): {
  rows: MintBurnRow[];
  dropped: number;
  droppedDecode: number;
  earliestDecodeFailureBlock: number | null;
} {
  const rows: MintBurnRow[] = [];
  const direction = eventDef.direction;
  let dropped = 0;
  let droppedDecode = 0;
  let earliestDecodeFailureBlock: number | null = null;

  for (const log of logs) {
    const slot = eventDef.amountEncoding === "nth-data-uint256" ? (eventDef.dataSlot ?? 0) : 0;
    const amount = decodeUint256AtSlotOrNull(log.data, slot, config.decimals);
    if (amount == null) {
      droppedDecode++;
      const blockNum = parseInt(log.blockNumber, 16);
      if (Number.isFinite(blockNum)) {
        earliestDecodeFailureBlock = earliestDecodeFailureBlock == null
          ? blockNum
          : Math.min(earliestDecodeFailureBlock, blockNum);
      }
      continue;
    }
    if (amount <= 0 || amount < config.dustThreshold) {
      dropped++;
      continue;
    }

    const blockNum = parseInt(log.blockNumber, 16);
    const logIndex = parseInt(log.logIndex, 16);
    const timestamp = blockTimestamps.get(blockNum) ?? 0;
    if (isNaN(blockNum) || isNaN(logIndex) || !timestamp) {
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

    const eventPrice = resolveMintBurnEventPrice(config.stablecoinId, timestamp, priceContext);
    const amountUsd = eventPrice ? amount * eventPrice.price : null;

    rows.push({
      id,
      stablecoin_id: config.stablecoinId,
      symbol: config.symbol,
      chain_id: config.chain.chainId,
      direction,
      amount,
      amount_usd: amountUsd,
      price_used: eventPrice?.price ?? null,
      price_timestamp: eventPrice?.priceTimestamp ?? null,
      price_source: eventPrice ? PARSE_PRICE_SOURCE_BY_EVIDENCE[eventPrice.evidence] : null,
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

  return { rows, dropped, droppedDecode, earliestDecodeFailureBlock };
}
