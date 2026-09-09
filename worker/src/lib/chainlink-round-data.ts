const LATEST_ROUND_DATA_REQUIRED_HEX_CHARS = 256;

/** Why a decoded round carries no usable price evidence. */
export type ChainlinkRoundInvalidReason = "non-positive-answer" | "non-positive-updated-at";

export interface ChainlinkLatestRoundData {
  roundId: bigint;
  answer: bigint;
  updatedAt: number;
  /** Null when the round is usable evidence; otherwise the reason it is not. */
  invalidReason: ChainlinkRoundInvalidReason | null;
}

const INVALID_ROUND_MESSAGE: Record<ChainlinkRoundInvalidReason, string> = {
  "non-positive-answer": "latestRoundData returned non-positive answer",
  "non-positive-updated-at": "latestRoundData returned non-positive updatedAt",
};

function parseHexWord(word: string): bigint {
  return BigInt(`0x${word}`);
}

export function parseSignedInt256Word(word: string): bigint {
  const value = parseHexWord(word);
  const signBit = 1n << 255n;
  return (value & signBit) === 0n ? value : value - (1n << 256n);
}

/**
 * Decodes an AggregatorV3 `latestRoundData()` response. A response that cannot
 * be decoded at all is a transport/ABI failure and throws; a decodable round
 * whose answer or timestamp is unusable is returned with `invalidReason` set so
 * callers can classify it as unavailable evidence rather than a fetch error.
 */
export function parseChainlinkLatestRoundData(
  hex: string,
  sourceLabel = "chainlink",
): ChainlinkLatestRoundData {
  const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (stripped.length < LATEST_ROUND_DATA_REQUIRED_HEX_CHARS) {
    throw new Error(`${sourceLabel}: latestRoundData response too short (${stripped.length} hex chars)`);
  }
  if (!/^[0-9a-fA-F]+$/.test(stripped)) {
    throw new Error(`${sourceLabel}: latestRoundData response contains malformed hex`);
  }

  const roundId = parseHexWord(stripped.slice(0, 64));
  const answer = parseSignedInt256Word(stripped.slice(64, 128));
  const updatedAt = Number(parseHexWord(stripped.slice(192, 256)));

  const invalidReason: ChainlinkRoundInvalidReason | null = answer <= 0n
    ? "non-positive-answer"
    : updatedAt <= 0
      ? "non-positive-updated-at"
      : null;

  return { roundId, answer, updatedAt, invalidReason };
}

/**
 * Fail-closed variant for reserve adapters, whose only "no evidence this run"
 * signal is a thrown error carrying the source label.
 */
export function requireChainlinkLatestRoundData(
  hex: string,
  sourceLabel = "chainlink",
): ChainlinkLatestRoundData {
  const round = parseChainlinkLatestRoundData(hex, sourceLabel);
  if (round.invalidReason) {
    throw new Error(`${sourceLabel}: ${INVALID_ROUND_MESSAGE[round.invalidReason]}`);
  }
  return round;
}
