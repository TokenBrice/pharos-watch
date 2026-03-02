import { ETHERSCAN_V2_BASE } from "../lib/constants";
import { getCache, setCacheIfNewer } from "../lib/db";
import { fetchWithRetry } from "../lib/fetch-retry";

const CACHE_KEY = "usds-status";
const STALE_HOURS = 20;

// USDS proxy (UUPS / ERC-1967)
const USDS_PROXY = "0xdC035D45d973E3EC169d2276DDab16f1e407384F";
// ERC-1967 implementation storage slot
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
// Known implementation without freeze functionality
const NO_FREEZE_IMPL = "0x1923dfee706a8e78157416c29cbccfde7cdf4102";
// Ethereum mainnet
const ETH_CHAIN_ID = 1;
// isBlocked(address) selector = keccak256("isBlocked(address)")[:4]
const IS_BLOCKED_SELECTOR = "0xe4c0aaf4";

interface UsdsStatus {
  freezeActive: boolean;
  implementationAddress: string;
  lastChecked: number;
}

async function readImplementationSlot(apiKey: string | null): Promise<string | null> {
  const params = new URLSearchParams({
    chainid: ETH_CHAIN_ID.toString(),
    module: "proxy",
    action: "eth_getStorageAt",
    address: USDS_PROXY,
    position: IMPL_SLOT,
    tag: "latest",
  });
  if (apiKey) params.set("apikey", apiKey);

  try {
    const res = await fetchWithRetry(`${ETHERSCAN_V2_BASE}?${params}`);
    if (!res || !res.ok) return null;
    const json = (await res.json()) as { result?: string };
    if (!json.result || json.result === "0x") return null;
    // Result is a 32-byte hex — extract the address from the last 20 bytes
    return "0x" + json.result.slice(-40).toLowerCase();
  } catch (e) {
    console.warn("[sync-usds] getImplementationAddress failed:", e);
    return null;
  }
}

async function probeFreeze(implAddress: string, apiKey: string | null): Promise<boolean | null> {
  // Call isBlocked(address(0)) on the proxy — if the implementation has the function
  // it will return data; otherwise it will revert (empty result or error)
  const data = IS_BLOCKED_SELECTOR + "0".repeat(64);
  const params = new URLSearchParams({
    chainid: ETH_CHAIN_ID.toString(),
    module: "proxy",
    action: "eth_call",
    to: USDS_PROXY,
    data,
    tag: "latest",
  });
  if (apiKey) params.set("apikey", apiKey);

  try {
    const res = await fetchWithRetry(`${ETHERSCAN_V2_BASE}?${params}`);
    if (!res || !res.ok) return null;
    const json = (await res.json()) as { result?: string };
    // A successful call returns at least 66 chars (0x + 32 bytes)
    return !!json.result && json.result.length >= 66;
  } catch (e) {
    console.warn("[sync-usds] probeFreeze failed:", e);
    return null;
  }
}

export async function syncUsdsStatus(
  db: D1Database,
  etherscanApiKey: string | null,
  _signal?: AbortSignal,
): Promise<{ itemCount: number } | void> {
  const syncStartSec = Math.floor(Date.now() / 1000);

  // Check if cache is still fresh
  const cached = await getCache(db, CACHE_KEY);
  if (cached) {
    const age = Date.now() / 1000 - cached.updatedAt;
    if (age < STALE_HOURS * 3600) {
      console.log("[usds-status] Cache still fresh, skipping");
      return;
    }
  }

  const implAddress = await readImplementationSlot(etherscanApiKey);
  if (!implAddress) {
    console.warn("[usds-status] Failed to read implementation slot");
    return;
  }

  let freezeActive = false;
  if (implAddress !== NO_FREEZE_IMPL) {
    // Implementation changed — probe for freeze function
    const probeResult = await probeFreeze(implAddress, etherscanApiKey);
    if (probeResult === null) {
      console.warn("[usds-status] Probe failed, preserving cached status");
      return;
    }
    freezeActive = probeResult;
    console.log(`[usds-status] Implementation changed to ${implAddress}, freeze active: ${freezeActive}`);
  } else {
    console.log("[usds-status] Implementation unchanged, no freeze");
  }

  const status: UsdsStatus = {
    freezeActive,
    implementationAddress: implAddress,
    lastChecked: Math.floor(Date.now() / 1000),
  };

  await setCacheIfNewer(db, CACHE_KEY, JSON.stringify(status), syncStartSec);
  console.log("[usds-status] Cache updated");
  return { itemCount: 1 };
}
