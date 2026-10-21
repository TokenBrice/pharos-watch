import {
  SFRAX_STOCK_CHAINS,
  SFRAX_STOCK_MAX_AGE_SEC,
  SfraxStockPerimeterObservationSchema,
} from "../types/sfrax-supply";
import { CHAIN_META } from "../types/chain-identity";

const EVM_SCALE = 10n ** 18n;
const SOLANA_TO_EVM_SCALE = 10n ** 9n;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT64 = (1n << 64n) - 1n;

/** Derive current token-stock float. No unminted pending or extinguished-claim assertion is made. */
export function deriveSfraxStockPerimeter(value: unknown) {
  const parsed = SfraxStockPerimeterObservationSchema.safeParse(value);
  if (!parsed.success) return null;
  const observation = parsed.data;
  if (observation.readStartedAt > observation.readCompletedAt) return null;
  let observedAt = observation.readCompletedAt;
  for (const chain of SFRAX_STOCK_CHAINS) {
    const block = observation.blocks[chain];
    if (chain === "solana" ? !("slot" in block) : !("number" in block)) return null;
    if (block.timestamp > observation.readCompletedAt || observation.readCompletedAt - block.timestamp > SFRAX_STOCK_MAX_AGE_SEC) return null;
    observedAt = Math.min(observedAt, block.timestamp);
  }
  const gross = Object.fromEntries(SFRAX_STOCK_CHAINS.map((chain) => [chain, BigInt(observation.grossSupplyRaw[chain])])) as Record<typeof SFRAX_STOCK_CHAINS[number], bigint>;
  if (Object.values(gross).some((raw) => raw > MAX_UINT256) || gross.solana > MAX_UINT64 || gross.ethereum <= 0n) return null;
  const custody = Object.values(observation.nativeCustodyRaw).map((raw) => BigInt(raw));
  if (custody.some((raw) => raw > MAX_UINT256)) return null;
  if (observation.migratedDepositsRaw !== observation.nativeCustodyRaw.migratedStandardBridge) return null;
  const excludedNative = custody.reduce((sum, raw) => sum + raw, 0n);
  if (excludedNative > gross.ethereum) return null;
  const nativeAvailable = gross.ethereum - excludedNative;
  // This observed ordinary-holder balance remains included, never silently deducted.
  if (BigInt(observation.compoundHolderBalanceRaw) > nativeAvailable) return null;
  const chainSupplyRaw = { ...gross, ethereum: nativeAvailable, solana: gross.solana * SOLANA_TO_EVM_SCALE };
  let excludedRemote = 0n;
  for (const chain of ["arbitrum", "avalanche", "bsc", "optimism"] as const) {
    const prefunded = BigInt(observation.remotePrefundedRaw[chain]);
    if (prefunded > gross[chain]) return null;
    chainSupplyRaw[chain] -= prefunded;
    excludedRemote += prefunded;
  }
  const totalSupplyRaw = Object.values(chainSupplyRaw).reduce((sum, raw) => sum + raw, 0n);
  const allMintedRaw = gross.ethereum + SFRAX_STOCK_CHAINS.reduce((sum, chain) =>
    chain === "ethereum" ? sum : sum + gross[chain] * (chain === "solana" ? SOLANA_TO_EVM_SCALE : 1n), 0n);
  if (totalSupplyRaw <= 0n || totalSupplyRaw + excludedNative + excludedRemote !== allMintedRaw) return null;
  const chainCirculating = Object.fromEntries(SFRAX_STOCK_CHAINS.map((chain) => [CHAIN_META[chain].name, {
    chainId: chain,
    current: Number(chainSupplyRaw[chain]) / Number(EVM_SCALE) * observation.priceUsd,
  }]));
  const mcap = Object.values(chainCirculating).reduce((sum, row) => sum + row.current, 0);
  if (!Number.isFinite(mcap) || mcap <= 0) return null;
  return { observation, observedAt, totalSupplyRaw, chainSupplyRaw, chainCirculating, mcap };
}
