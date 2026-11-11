/** D1 batch statement limit per db.batch() call */
export const D1_BATCH_SIZE = 100;

// --- External API base URLs ---

export const ETHERSCAN_V2_BASE = "https://api.etherscan.io/v2/api";

export const DEFILLAMA_BASE = "https://stablecoins.llama.fi";
export const DEFILLAMA_COINS = "https://coins.llama.fi";
export const DEFILLAMA_API = "https://api.llama.fi";
export const STELLAR_HORIZON_API = "https://horizon.stellar.org";

export const USER_AGENT = "Pharos/1.0 (stablecoin analytics)";

// --- Circuit breaker source names ---

export { CIRCUIT_SOURCE } from "@shared/lib/circuit-sources";
