import type { AlchemyLogEntry, AlchemyTopicFilter } from "./alchemy-logs";

export const MINT_BURN_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const ZERO = `0x${"0".repeat(64)}`;
const WORD = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_WORD = /^0x0{24}[0-9a-fA-F]{40}$/;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;

export function mintBurnLogQuantity(value: unknown): number {
  if (typeof value !== "string" || !QUANTITY.test(value)) throw new Error("invalid-rpc-quantity");
  const parsed = Number(BigInt(value));
  if (!Number.isSafeInteger(parsed)) throw new Error("unsafe-rpc-quantity");
  return parsed;
}

/** Shared response identity boundary; conservation adds its reviewed amount/law checks. */
export function createMintBurnLogIdentityValidator() {
  const seen = new Map<string, string>();
  const blockHashes = new Map<number, string>();
  return {
    blockHashes,
    validate(log: AlchemyLogEntry, emitter: string, topics: readonly AlchemyTopicFilter[],
      fromBlock: number, toBlock: number, topicArity?: number): boolean {
      const block = mintBurnLogQuantity(log.blockNumber);
      const transactionIndex = mintBurnLogQuantity(log.transactionIndex);
      const index = mintBurnLogQuantity(log.logIndex);
      if (log.removed !== false || log.address.toLowerCase() !== emitter.toLowerCase() ||
        block < fromBlock || block > toBlock || !WORD.test(log.blockHash) || log.blockHash === ZERO ||
        !WORD.test(log.transactionHash) || log.transactionHash === ZERO ||
        (topicArity != null && log.topics.length !== topicArity)) throw new Error("invalid-raw-log");
      for (const { index: topicIndex, value } of topics) {
        const actual = log.topics[topicIndex]?.toLowerCase();
        if (!(typeof value === "string" ? [value] : value).some((expected) => expected.toLowerCase() === actual)) {
          throw new Error("invalid-raw-log");
        }
      }
      if (log.topics[0]?.toLowerCase() === MINT_BURN_TRANSFER_TOPIC && (topicArity == null || topicArity === 3) &&
        (log.topics.length !== 3 || !ADDRESS_WORD.test(log.topics[1]!) || !ADDRESS_WORD.test(log.topics[2]!))) {
        throw new Error("invalid-raw-log");
      }
      const hash = log.blockHash.toLowerCase();
      if (blockHashes.has(block) && blockHashes.get(block) !== hash) throw new Error("inconsistent-log-block-hash");
      blockHashes.set(block, hash);
      const key = `${log.transactionHash.toLowerCase()}:${index}`;
      const identity = JSON.stringify([block, hash, transactionIndex, log.topics.map((topic) => topic.toLowerCase()), log.data.toLowerCase()]);
      if (seen.has(key)) {
        if (seen.get(key) !== identity) throw new Error("conflicting-duplicate-log");
        return false;
      }
      seen.set(key, identity);
      return true;
    },
  };
}
