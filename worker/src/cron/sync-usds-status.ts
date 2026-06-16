import type { UsdsStatusResponse } from "@shared/types";
import { UsdsStatusResponseSchema } from "@shared/types/stability";
import { shouldSkipFreshCache, setCacheIfNewer, type CacheWriteResult } from "../lib/db-cache";
import type { CronResult } from "../lib/cron-logger";
import { fetchEtherscanProxyHex } from "../lib/evm-rpc";
import { shouldAttemptFetch, recordOutcomeSafe } from "../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../lib/constants";

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
const THIRTY_TWO_BYTE_HEX_RE = /^0x[a-fA-F0-9]{64}$/;
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

async function readImplementationSlot(apiKey: string | null, signal?: AbortSignal): Promise<string | null> {
  try {
    const result = await fetchEtherscanProxyHex({
      evmChainId: ETH_CHAIN_ID,
      action: "eth_getStorageAt",
      address: USDS_PROXY,
      position: IMPL_SLOT,
      blockNumberOrTag: "latest",
      apiKey,
      signal,
    });
    if (!result) return null;
    if (!THIRTY_TWO_BYTE_HEX_RE.test(result)) return null;
    // Result is a 32-byte hex — extract the address from the last 20 bytes
    const implementationAddress = `0x${result.slice(-40).toLowerCase()}`;
    return EVM_ADDRESS_RE.test(implementationAddress) ? implementationAddress : null;
  } catch (e) {
    console.warn("[sync-usds] getImplementationAddress failed:", e);
    return null;
  }
}

async function probeFreezeCapability(apiKey: string | null, signal?: AbortSignal): Promise<boolean | null> {
  // Call isBlocked(address(0)) on the proxy. A 32-byte response proves the
  // implementation exposes blacklist/freeze capability; it does not mean any
  // specific account is currently frozen.
  const data = IS_BLOCKED_SELECTOR + "0".repeat(64);
  try {
    const result = await fetchEtherscanProxyHex({
      evmChainId: ETH_CHAIN_ID,
      action: "eth_call",
      to: USDS_PROXY,
      data,
      blockNumberOrTag: "latest",
      apiKey,
      signal,
    });
    if (!result) return null;
    if (!THIRTY_TWO_BYTE_HEX_RE.test(result)) return null;
    return true;
  } catch (e) {
    console.warn("[sync-usds] probeFreezeCapability failed:", e);
    return null;
  }
}

export async function syncUsdsStatus(
  db: D1Database,
  etherscanApiKey: string | null,
  signal?: AbortSignal,
): Promise<CronResult> {
  const syncStartSec = Math.floor(Date.now() / 1000);

  if (await shouldSkipFreshCache(db, CACHE_KEY, STALE_HOURS * 3600)) {
    console.log("[usds-status] Cache still fresh, skipping");
    return { itemCount: 0, metadata: JSON.stringify({ reason: "cache-fresh" }) };
  }

  if (!(await shouldAttemptFetch(db, CIRCUIT_SOURCE.ETHERSCAN))) {
    return { status: "degraded", itemCount: 0, metadata: JSON.stringify({ reason: "etherscan-circuit-open" }) };
  }

  const implementationAddress = await readImplementationSlot(etherscanApiKey, signal);
  if (!implementationAddress) {
    await recordOutcomeSafe(db, CIRCUIT_SOURCE.ETHERSCAN, false);
    console.warn("[usds-status] Failed to read implementation slot");
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({ reason: "implementation-slot-unavailable" }),
    };
  }

  let freezeCapabilityPresent = false;
  if (implementationAddress !== NO_FREEZE_IMPL) {
    // Implementation changed — probe for freeze function
    const probeResult = await probeFreezeCapability(etherscanApiKey, signal);
    if (probeResult === null) {
      await recordOutcomeSafe(db, CIRCUIT_SOURCE.ETHERSCAN, false);
      console.warn("[usds-status] Probe failed, preserving cached status");
      return {
        status: "degraded",
        itemCount: 0,
        metadata: JSON.stringify({ reason: "freeze-probe-failed", implementationAddress }),
      };
    }
    freezeCapabilityPresent = probeResult;
    console.log(`[usds-status] Implementation changed to ${implementationAddress}, freeze capability present: ${freezeCapabilityPresent}`);
  } else {
    console.log("[usds-status] Implementation unchanged, no freeze capability");
  }

  const statusResult = UsdsStatusResponseSchema.safeParse({
    freezeCapabilityPresent,
    // Deprecated alias mirroring freezeCapabilityPresent — capability presence
    // is the only observable signal here, not actual freeze use. See audit Q-238.
    freezeActive: freezeCapabilityPresent,
    implementationAddress,
    lastChecked: syncStartSec,
  });
  if (!statusResult.success) {
    await recordOutcomeSafe(db, CIRCUIT_SOURCE.ETHERSCAN, false);
    console.error("[sync-usds-status] Status payload validation failed:", statusResult.error.issues);
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        reason: "status-payload-invalid",
        implementationAddress,
        freezeCapabilityPresent,
        freezeActive: freezeCapabilityPresent,
      }),
    };
  }
  const status: UsdsStatusResponse = statusResult.data;

  let cacheResult: CacheWriteResult;
  try {
    cacheResult = await setCacheIfNewer(db, CACHE_KEY, JSON.stringify(status), syncStartSec, signal);
  } catch (err) {
    await recordOutcomeSafe(db, CIRCUIT_SOURCE.ETHERSCAN, true);
    console.error("[sync-usds-status] Cache write failed:", err);
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        reason: "cache-write-failed",
        implementationAddress,
        freezeCapabilityPresent,
        freezeActive: freezeCapabilityPresent,
      }),
    };
  }
  await recordOutcomeSafe(db, CIRCUIT_SOURCE.ETHERSCAN, true);
  console.log(
    cacheResult.written ? "[usds-status] Cache updated" : "[usds-status] Cache update skipped; newer row exists",
  );
  return {
    itemCount: cacheResult.written ? 1 : 0,
    metadata: JSON.stringify({
      implementationAddress,
      freezeCapabilityPresent,
      freezeActive: freezeCapabilityPresent,
      cacheKey: CACHE_KEY,
      syncStartSec,
      cacheWriteMode: cacheResult.written ? "published" : "skipped-newer",
      casSkipped: cacheResult.skippedBecauseNewer,
    }),
  };
}
