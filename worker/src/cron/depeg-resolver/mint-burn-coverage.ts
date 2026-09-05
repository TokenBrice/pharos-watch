import { MINT_BURN_CONFIGS } from "../../lib/mint-burn-contracts";

/** Stablecoins with mint/burn hourly coverage (single DDR membership owner). */
export const MINT_BURN_COVERED_COIN_IDS = new Set(MINT_BURN_CONFIGS.map((config) => config.stablecoinId));
