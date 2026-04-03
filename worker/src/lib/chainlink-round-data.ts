export interface ChainlinkLatestRoundData {
  roundId: bigint;
  answer: bigint;
  updatedAt: number;
}

function parseHexWord(word: string): bigint {
  return BigInt(`0x${word}`);
}

export function parseSignedInt256Word(word: string): bigint {
  const value = parseHexWord(word);
  const signBit = 1n << 255n;
  return (value & signBit) === 0n ? value : value - (1n << 256n);
}

export function parseChainlinkLatestRoundData(
  hex: string,
  sourceLabel = "chainlink",
): ChainlinkLatestRoundData {
  const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (stripped.length < 320) {
    throw new Error(`${sourceLabel}: latestRoundData response too short (${stripped.length} hex chars)`);
  }

  const roundId = parseHexWord(stripped.slice(0, 64));
  const answer = parseSignedInt256Word(stripped.slice(64, 128));
  const updatedAt = Number(parseHexWord(stripped.slice(192, 256)));

  if (answer <= 0n) {
    throw new Error(`${sourceLabel}: latestRoundData returned non-positive answer`);
  }
  if (updatedAt <= 0) {
    throw new Error(`${sourceLabel}: latestRoundData returned non-positive updatedAt`);
  }

  return { roundId, answer, updatedAt };
}
