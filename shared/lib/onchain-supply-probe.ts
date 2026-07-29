import { CHAIN_META } from "./chains";
import type { StablecoinMeta } from "../types";

export type OnchainSupplyContract = NonNullable<StablecoinMeta["contracts"]>[number];

export interface CuratedOnchainSupplyContractConfig {
  chain: string;
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  /**
   * Some reviewed native deployments are live with zero supply. Keep this
   * opt-in so ordinary aggregate paths still fail closed on empty reads.
   */
  allowZeroSupply?: boolean;
}

export interface CuratedAggregateOnchainSupplyContract {
  config: CuratedOnchainSupplyContractConfig;
  contract: OnchainSupplyContract;
}

export const ZEPHYR_ZSD_ASSET_ID = "zsd-zephyr-protocol";
export const ZEPHYR_ZYS_ASSET_ID = "zys-zephyr-protocol";

const ZEPHYR_SCANNER_SUPPLY_IDS = new Set([ZEPHYR_ZSD_ASSET_ID, ZEPHYR_ZYS_ASSET_ID]);
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export const CURATED_ONCHAIN_SUPPLY_CONTRACTS: Record<string, CuratedOnchainSupplyContractConfig> = {
  // No upstream market row exists for Spark Savings USDC yet, but the Ethereum
  // vault supply plus the guarded protocol-redeem price keeps the asset visible.
  "susdc-spark": { chain: "ethereum" },
};

const CURATED_AGGREGATE_ONCHAIN_SUPPLY_CONTRACTS: Record<
  string,
  readonly CuratedOnchainSupplyContractConfig[]
> = {
  // DefiLlama currently lists these active assets but intermittently reports a
  // zero supply row. Use only verified live deployments and fail closed if any
  // configured chain cannot be read, so this cannot silently undercount.
  "cadd-cad-digital": [{ chain: "ethereum" }, { chain: "base" }],
  // AllUnity lists CHFAU as issuer-native on Ethereum, Polygon, Base, and Tempo.
  // DefiLlama does not list it and CoinGecko exposes no usable market cap, so
  // aggregate the reviewed deployments and allow live zero-supply legs.
  "chfau-allunity": [
    { chain: "ethereum", allowZeroSupply: true },
    { chain: "polygon", allowZeroSupply: true },
    { chain: "base", allowZeroSupply: true },
    { chain: "tempo", allowZeroSupply: true },
  ],
  // CoinGecko only exposes an Ethereum market-cap row for ftUSD and currently
  // leaves it stale; aggregate the verified native Ethereum + Sonic supplies.
  "ftusd-flying-tulip": [{ chain: "ethereum" }, { chain: "sonic" }],
  // apyUSD is issued through a CCIP burn/mint pair on Ethereum and Base.
  // CoinGecko supplies the aggregate NAV market cap but no per-chain split, so
  // read both reviewed deployments and conserve their combined live supply.
  "apyusd-apyx": [{ chain: "ethereum" }, { chain: "base" }],
  // DUSD is a Makina Machine share issued canonically on Ethereum and mirrored
  // to Ink through Wormhole NTT locking. Ethereum totalSupply already includes
  // the tokens escrowed for Ink, so the aggregate path must reallocate rather
  // than sum the two deployments.
  "dusd-dialectic": [
    { chain: "ethereum" },
    { chain: "ink", rpcUrl: "https://rpc-gel.inkonchain.com" },
  ],
  "jpym-mento": [{ chain: "celo" }],
  "zarm-mento": [{ chain: "celo" }],
  "xofm-mento": [{ chain: "celo" }],
  // sUSDS and sDAI are Sky savings NAV wrappers with no DefiLlama market row
  // (llamaId null), so upstream supplies no per-chain breakdown and the
  // CoinGecko intake lanes leave chainCirculating empty. Aggregate the verified
  // native + canonical-bridge deployments (contracts sourced from the coin JSONs)
  // so the V9 supply review reconciles real per-chain rows instead of capping on
  // runtime-bridge-materiality-unavailable.
  "susds-sky": [{ chain: "ethereum" }, { chain: "base" }, { chain: "optimism" }, { chain: "arbitrum" }],
  "sdai-sky": [{ chain: "ethereum" }, { chain: "base" }, { chain: "optimism" }],
};

// These canonical-chain totalSupply values already include tokens escrowed for
// the listed lock/mint representations. Reallocate that supply across chains
// instead of adding representation supplies to the canonical total.
export const CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS: Readonly<Record<string, string>> = {
  "dusd-dialectic": "ethereum",
  "susds-sky": "ethereum",
  "sdai-sky": "ethereum",
};

export function isZephyrScannerSupplyId(id: string): boolean {
  return ZEPHYR_SCANNER_SUPPLY_IDS.has(id);
}

export function supportsOnchainSupplyProbe(contract: OnchainSupplyContract): boolean {
  if (contract.chain === "solana") return contract.address.length > 0;
  return CHAIN_META[contract.chain]?.type === "evm" && EVM_ADDRESS_RE.test(contract.address);
}

export function selectSingleOnchainSupplyProbeContract(meta: StablecoinMeta): OnchainSupplyContract | null {
  const contracts = meta.contracts ?? [];
  if (contracts.length !== 1) return null;
  const [contract] = contracts;
  return contract && supportsOnchainSupplyProbe(contract) ? contract : null;
}

export function selectSupplementalOnchainSupplyProbeContract(meta: StablecoinMeta): OnchainSupplyContract | null {
  const curated = CURATED_ONCHAIN_SUPPLY_CONTRACTS[meta.id];
  if (curated) {
    const contract = meta.contracts?.find((entry) => entry.chain === curated.chain);
    return contract && supportsOnchainSupplyProbe(contract) ? contract : null;
  }

  return selectSingleOnchainSupplyProbeContract(meta);
}

export function selectCuratedAggregateOnchainSupplyProbeContracts(
  meta: StablecoinMeta,
): readonly CuratedAggregateOnchainSupplyContract[] | null {
  const curatedContracts = CURATED_AGGREGATE_ONCHAIN_SUPPLY_CONTRACTS[meta.id];
  if (!curatedContracts || curatedContracts.length === 0) return null;

  const selected: CuratedAggregateOnchainSupplyContract[] = [];
  for (const config of curatedContracts) {
    const contract = meta.contracts?.find((entry) => entry.chain === config.chain);
    if (!contract || !supportsOnchainSupplyProbe(contract)) return null;
    selected.push({ config, contract });
  }

  return selected;
}

export function hasRuntimeOnchainSupplyPath(meta: StablecoinMeta): boolean {
  return (
    isZephyrScannerSupplyId(meta.id) ||
    selectSupplementalOnchainSupplyProbeContract(meta) != null ||
    selectCuratedAggregateOnchainSupplyProbeContracts(meta) != null
  );
}
