import type { ContractEventConfig } from "../../../lib/blacklist-contracts";
import type { BlacklistRow } from "../../../lib/blacklist/shared";
import { makeBlacklistRow } from "../../../test-helpers/__shared/fixtures";

export const ethereumConfig: ContractEventConfig = {
  configKey: "ethereum-0xdac17f958d2ee523a2206206994597c13d831ec7",
  chain: {
    chainId: "ethereum",
    chainName: "Ethereum",
    evmChainId: 1,
    explorerUrl: "https://etherscan.io",
    type: "evm",
  },
  stablecoinId: "usdt-tether",
  stablecoin: "USDT",
  contractAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  decimals: 6,
  events: [],
};

export function makeCacheRow(overrides: Partial<BlacklistRow> = {}): BlacklistRow {
  const row = makeBlacklistRow({
    methodology_version: "3.5",
    contract_address: ethereumConfig.contractAddress,
    event_topic0: "0xtopic",
    ...overrides,
  });
  return {
    ...row,
    methodology_version: row.methodology_version ?? "3.5",
    amount_attempt_count: row.amount_attempt_count ?? 0,
    amount_last_attempted_at: row.amount_last_attempted_at ?? null,
    amount_last_error_class: row.amount_last_error_class ?? null,
    amount_last_provider: row.amount_last_provider ?? null,
    explorer_tx_url: overrides.explorer_tx_url ?? `https://etherscan.io/tx/${row.tx_hash}`,
    explorer_address_url: overrides.explorer_address_url ?? `https://etherscan.io/address/${row.address}`,
  };
}
