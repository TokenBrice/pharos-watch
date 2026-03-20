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
  if (stripped.length < 256) {
    throw new Error(`${sourceLabel}: latestRoundData response too short (${stripped.length} hex chars)`);
  }

  const roundId = BigInt(`0x${stripped.slice(0, 64)}`);
  const answer = BigInt(`0x${stripped.slice(64, 128)}`);
  // word 2 = startedAt (skip)
  const updatedAt = Number(BigInt(`0x${stripped.slice(192, 256)}`));

  if (answer <= 0n) {
    throw new Error(`${sourceLabel}: latestRoundData returned non-positive answer`);
  }
  if (updatedAt <= 0) {
    throw new Error(`${sourceLabel}: latestRoundData returned non-positive updatedAt`);
  }

  return { roundId, answer, updatedAt };
}
