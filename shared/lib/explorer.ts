import { CHAIN_META } from "./chains";

export type ExplorerEntityType = "tx" | "address" | "contract";

interface ExplorerUrlInput {
  chainKey?: string;
  explorerUrl?: string;
  chainType?: "evm" | "tron" | "other";
  entityType: ExplorerEntityType;
  value: string;
}

function normalizeTronAddress(value: string): string {
  return value.startsWith("0x") ? `41${value.slice(2)}` : value;
}

export function buildExplorerUrl(input: ExplorerUrlInput): string | null {
  const meta = input.chainKey ? CHAIN_META[input.chainKey] : undefined;
  const explorerUrl = input.explorerUrl ?? meta?.explorerUrl;
  const chainType = input.chainType ?? meta?.type;
  if (!explorerUrl || !chainType) return null;

  if (input.entityType === "tx") {
    return chainType === "tron"
      ? `${explorerUrl}/#/transaction/${input.value}`
      : `${explorerUrl}/tx/${input.value}`;
  }

  if (chainType === "tron") {
    const normalized = normalizeTronAddress(input.value);
    return input.entityType === "contract"
      ? `${explorerUrl}/#/contract/${normalized}`
      : `${explorerUrl}/#/address/${normalized}`;
  }

  if (input.chainKey === "solana" || input.chainKey === "aptos") {
    return `${explorerUrl}/account/${input.value}`;
  }

  if (input.chainKey === "starknet" && input.entityType === "contract") {
    return `${explorerUrl}/contract/${input.value}`;
  }

  return `${explorerUrl}/address/${input.value}`;
}
