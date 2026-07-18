import { CHAIN_META } from "./chains";
import type { StablecoinMeta } from "../types";

export type OnchainSupplyContract = NonNullable<StablecoinMeta["contracts"]>[number];

export interface CuratedOnchainSupplyContractConfig {
  chain: string;
  rpcUrl?: string;
  fallbackRpcUrl?: string;
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
  // CoinGecko only exposes an Ethereum market-cap row for ftUSD and currently
  // leaves it stale; aggregate the verified native Ethereum + Sonic supplies.
  "ftusd-flying-tulip": [{ chain: "ethereum" }, { chain: "sonic" }],
  "jpym-mento": [{ chain: "celo" }],
  "phpm-mento": [{ chain: "celo" }],
  "zarm-mento": [{ chain: "celo" }],
  "xofm-mento": [{ chain: "celo" }],
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
