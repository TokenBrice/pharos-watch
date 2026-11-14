import type { DexPermanentLiquidity } from "@shared/types/dex-liquidity";

interface ReviewedPermanentLiquidityLock {
  chain: string;
  /** Lowercase pool address, as the Curve pool map keys it. */
  poolAddress: string;
  lpToken: string;
  holder: string;
  /** Holder's LP balance in raw token units at `verifiedAtBlock`. */
  lockedLpRaw: string;
  proof: "no-call-bytecode" | "burn-address";
  verifiedAtBlock: number;
}

/**
 * Reviewed LP locks: pool LP tokens held by an address that provably cannot
 * move them. `no-call-bytecode` means the holder's runtime code has no CALL,
 * CALLCODE or DELEGATECALL instruction, so it can never transfer or approve a
 * token; `burn-address` means no key can exist for it. Such a balance can only
 * grow, so `lockedLpRaw` stays a floor after `verifiedAtBlock`.
 * Review procedure and evidence: docs/dex-liquidity.md#permanent-liquidity.
 */
const REVIEWED_PERMANENT_LIQUIDITY_LOCKS: readonly ReviewedPermanentLiquidityLock[] = [
  {
    // LUSD/3CRV: a single transfer on 2021-09-18 to the Ebakus token contract
    // (tx 0x1990562bd2031e1582b821aa136356b9835023d1578725c57f9b399428825ba6).
    chain: "ethereum",
    poolAddress: "0xed279fdd11ca84beef15af5d39bb4d4bee23f0ca",
    lpToken: "0xed279fdd11ca84beef15af5d39bb4d4bee23f0ca",
    holder: "0xbddab785b306bcd9fb056da189615cc8ece1d823",
    lockedLpRaw: "11036306658186216357784389",
    proof: "no-call-bytecode",
    verifiedAtBlock: 26412233,
  },
];

/**
 * Share of a pool's LP supply behind a reviewed lock, from the LP total supply
 * the source reported this run. An unreadable supply, or one smaller than the
 * locked amount, publishes nothing: an unknown share is never zero.
 */
export function resolvePermanentLiquidity(
  chain: string,
  poolAddress: string,
  totalSupplyRaw: unknown,
): DexPermanentLiquidity | null {
  const address = poolAddress.toLowerCase();
  const lock = REVIEWED_PERMANENT_LIQUIDITY_LOCKS.find((entry) => entry.chain === chain && entry.poolAddress === address);
  if (!lock) return null;
  // Raw LP units exceed a double's exact range, so the comparison is integer-exact.
  if (typeof totalSupplyRaw !== "string" || !/^\d+$/.test(totalSupplyRaw)) return null;
  const locked = BigInt(lock.lockedLpRaw);
  const totalSupply = BigInt(totalSupplyRaw);
  if (totalSupply < locked) return null;
  const lpShare = Number((locked * 10_000n) / totalSupply) / 10_000;
  if (lpShare <= 0) return null;
  return {
    lpShare,
    chain: lock.chain,
    lpToken: lock.lpToken,
    holder: lock.holder,
    proof: lock.proof,
    verifiedAtBlock: lock.verifiedAtBlock,
  };
}
