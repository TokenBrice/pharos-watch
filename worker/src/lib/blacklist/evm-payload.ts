import { decodeAbiParameters } from "viem/utils";
import type { BlacklistEventType } from "@shared/types/market";
import type { BlacklistEventDef } from "../blacklist-contracts";
import { decodeAddressWord, decodeUint256Word, readDataWord } from "../evm-logs";
import { BlacklistDecodeError } from "./decode-quarantine";

export interface BlacklistEvmPayload {
  address: string | string[];
  amount: number | null;
  eventType: BlacklistEventType;
}

/** Decode only registry-defined payload fields; callers own log identity and receipt matching. */
export function decodeBlacklistEvmPayload(
  event: BlacklistEventDef,
  log: { topics: readonly string[]; data: string },
  decimals: number,
): BlacklistEvmPayload {
  let eventType = event.eventType;
  if (typeof event.eventTypeFromDataBoolIndex === "number") {
    const word = readDataWord(log.data, event.eventTypeFromDataBoolIndex);
    if (word == null || !/^0x[0-9a-f]{64}$/i.test(word) || (BigInt(word) !== 0n && BigInt(word) !== 1n)) {
      throw new BlacklistDecodeError("invalid-direction-bool");
    }
    eventType = BigInt(word) === 1n ? "blacklist" : "unblacklist";
  }
  if (event.addressArrayData) {
    try {
      const [addresses] = decodeAbiParameters([{ type: "address[]" }], log.data as `0x${string}`);
      return { address: addresses.map((address) => address.toLowerCase()), amount: null, eventType };
    } catch {
      throw new BlacklistDecodeError("invalid-address-array");
    }
  }

  const topicIndex = event.addressTopicIndex ?? 1;
  const addressFromTopic = typeof event.addressDataIndex !== "number" && log.topics.length > topicIndex;
  const addressWord = typeof event.addressDataIndex === "number"
    ? readDataWord(log.data, event.addressDataIndex)
    : addressFromTopic ? log.topics[topicIndex] : readDataWord(log.data, 0);
  const address = typeof addressWord === "string" && /^(0x)?0{24}[0-9a-f]{40}$/i.test(addressWord)
    ? decodeAddressWord(addressWord) : null;
  if (!address) throw new BlacklistDecodeError("invalid-address");

  const amountWord = !event.hasAmount ? null
    : typeof event.amountTopicIndex === "number" ? log.topics[event.amountTopicIndex]
    : readDataWord(log.data, event.amountDataIndex ?? (addressFromTopic ? 0 : 1));
  return { address, amount: event.hasAmount ? decodeUint256Word(amountWord, decimals) : null, eventType };
}
