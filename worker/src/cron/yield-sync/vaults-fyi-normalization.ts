import { isRecord } from "@shared/lib/type-guards";
import { resolveCanonicalChain } from "./sources-helpers";
import type { ParsedRankableVault, VaultsFyiTelemetry } from "./vaults-fyi-types";

export const VAULTS_FYI_MIN_VAULT_SCORE = 70;
export const VAULTS_FYI_MAX_APY_PERCENT = 300;

const VAULTS_FYI_DROP_EXAMPLE_LIMIT = 5;

type VaultsFyiDropReason = "malformed" | "unsupported-chain" | "identity-miss" | "size-gate" | "warning";

export function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function getFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function getNestedRecord(value: unknown, key: string): Record<string, unknown> | null {
  return isRecord(value) && isRecord(value[key]) ? value[key] : null;
}

export function vaultsFyiNetworkToChain(value: unknown): string | null {
  const raw = getString(value);
  if (!raw) return null;
  if (raw === "mainnet") return "ethereum";
  if (raw === "mega-eth") return "megaeth";
  if (raw === "hyperliquid") return "hyperevm";
  return resolveCanonicalChain(raw);
}

export function rankableVaultNetwork(value: string): string {
  const chain = vaultsFyiNetworkToChain(value);
  if (chain === "ethereum") return "mainnet";
  if (chain === "megaeth") return "mega-eth";
  if (chain === "hyperevm") return "hyperliquid";
  return value;
}

export function resolveVaultsFyiChain(
  network: Record<string, unknown> | null,
  fallbackNetwork?: string,
): string | null {
  const numericChainId = getFiniteNumber(network?.chainId ?? network?.id);
  if (numericChainId != null) {
    return resolveCanonicalChain(numericChainId);
  }

  const caip = getString(network?.networkCaip ?? network?.caip);
  if (caip) {
    const match = caip.match(/^eip155:(\d+)$/);
    if (match?.[1]) {
      return resolveCanonicalChain(Number(match[1]));
    }
  }

  return vaultsFyiNetworkToChain(network?.name) ?? vaultsFyiNetworkToChain(fallbackNetwork);
}

export function recordVaultsFyiDrop(
  telemetry: VaultsFyiTelemetry,
  reason: VaultsFyiDropReason,
  example: string,
): void {
  if (reason === "malformed") telemetry.malformedDropCount += 1;
  else if (reason === "unsupported-chain") telemetry.unsupportedChainCount += 1;
  else if (reason === "identity-miss") telemetry.identityMissCount += 1;
  else if (reason === "size-gate") telemetry.sizeGateDropCount += 1;
  else telemetry.warningDropCount += 1;
  if (telemetry.dropExamples.length < VAULTS_FYI_DROP_EXAMPLE_LIMIT) {
    telemetry.dropExamples.push(`${reason}:${example}`);
  }
}

function parseRankableVault(value: string): ParsedRankableVault | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const separatorIndex = trimmed.includes("/") ? trimmed.indexOf("/") : trimmed.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) return null;
  const network = trimmed.slice(0, separatorIndex).trim();
  const vaultId = trimmed.slice(separatorIndex + 1).trim();
  return network && vaultId ? { network, vaultId } : null;
}

export function parseRankableVaults(values: readonly string[]): ParsedRankableVault[] {
  const seen = new Set<string>();
  const parsed: ParsedRankableVault[] = [];
  for (const value of values) {
    const entry = parseRankableVault(value);
    if (!entry) continue;
    const key = `${entry.network}:${entry.vaultId}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parsed.push(entry);
  }
  return parsed;
}

function getRankableVaultKey(network: string, vaultId: string): string {
  return `${network.trim().toLowerCase()}:${vaultId.trim().toLowerCase()}`;
}

export function buildRankableVaultKeySet(rankableVaults: ParsedRankableVault[]): Set<string> {
  const keys = new Set<string>();
  for (const entry of rankableVaults) {
    keys.add(getRankableVaultKey(entry.network, entry.vaultId));
    const chain = vaultsFyiNetworkToChain(entry.network);
    if (chain) keys.add(getRankableVaultKey(chain, entry.vaultId));
    if (chain === "ethereum") keys.add(getRankableVaultKey("mainnet", entry.vaultId));
    if (chain === "megaeth") keys.add(getRankableVaultKey("mega-eth", entry.vaultId));
    if (chain === "hyperevm") keys.add(getRankableVaultKey("hyperliquid", entry.vaultId));
  }
  return keys;
}

function rowNetworkKeys(row: Record<string, unknown>): string[] {
  const network = getNestedRecord(row, "network");
  const keys = new Set<string>();
  const name = getString(network?.name);
  const caip = getString(network?.networkCaip ?? network?.caip);
  const chain = resolveVaultsFyiChain(network);
  if (name) keys.add(name.toLowerCase());
  if (caip) keys.add(caip.toLowerCase());
  if (chain) {
    keys.add(chain);
    if (chain === "ethereum") keys.add("mainnet");
    if (chain === "megaeth") keys.add("mega-eth");
    if (chain === "hyperevm") keys.add("hyperliquid");
  }
  return [...keys];
}

export function isRankableVaultAllowed(row: Record<string, unknown>, allowedKeys: Set<string>): boolean {
  const vaultIds = [
    getString(row.vaultId),
    getString(row.id),
    getString(row.address),
    getString(row.vaultAddress),
  ].filter((value): value is string => value != null);
  if (vaultIds.length === 0) return false;

  for (const network of rowNetworkKeys(row)) {
    for (const vaultId of vaultIds) {
      if (allowedKeys.has(getRankableVaultKey(network, vaultId))) return true;
    }
  }
  return false;
}

export function extractRows(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (!isRecord(body)) return null;
  if (Array.isArray(body.data)) return body.data;
  if (Array.isArray(body.results)) return body.results;
  if (Array.isArray(body.vaults)) return body.vaults;
  return null;
}

export function extractDetailedVault(body: unknown): unknown | null {
  if (isRecord(body) && "data" in body) return body.data;
  return body;
}
