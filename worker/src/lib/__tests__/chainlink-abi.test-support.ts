/**
 * Shared AggregatorV3 ABI encoders for the Chainlink round-data parser owner
 * (`chainlink-round-data.test.ts`) and the reference-feed snapshot suite
 * (`chainlink-feeds.test.ts`). Adapter-level encoders stay with their adapters.
 */
export function encodeWord(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

/** Full five-word `latestRoundData()` response: roundId, answer, startedAt, updatedAt, answeredInRound. */
export function buildLatestRoundDataHex(answer: bigint, updatedAt: number): `0x${string}` {
  const words = [
    encodeWord(1n),
    // int256 answer: two's complement for negative feed answers.
    encodeWord(answer >= 0n ? answer : (1n << 256n) + answer),
    encodeWord(0n),
    encodeWord(BigInt(updatedAt)),
    encodeWord(1n),
  ];
  return `0x${words.join("")}`;
}
