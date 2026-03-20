export interface ChainlinkLatestRoundData {
  roundId: bigint;
  answer: bigint;
  updatedAt: number;
}

export function parseChainlinkLatestRoundData(
  hex: string,
  sourceLabel: string,
): ChainlinkLatestRoundData {
  const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (stripped.length < 160) {
    throw new Error(`${sourceLabel}: latestRoundData response too short (${stripped.length} hex chars)`);
  }

  return {
    roundId: BigInt(`0x${stripped.slice(0, 64)}`),
    answer: BigInt(`0x${stripped.slice(64, 128)}`),
    // word 2 = startedAt (skip)
    updatedAt: Number(BigInt(`0x${stripped.slice(192, 256)}`)),
  };
}
