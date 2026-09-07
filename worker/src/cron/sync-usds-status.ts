import type { UsdsStatusResponse } from "@shared/types";
import { UsdsStatusResponseSchema } from "@shared/types/stability";
import { shouldSkipFreshCache, setCacheIfNewer, type CacheWriteResult } from "../lib/db-cache";
import type { CronResult } from "../lib/cron-logger";
import { createCronResult } from "../lib/cron-result";
import { fetchEtherscanProxyHex } from "../lib/evm-rpc";
import { shouldAttemptFetch, recordOutcomeSafe } from "../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../lib/constants";
import { logWorkerEvent } from "../lib/structured-log";

const CACHE_KEY = "usds-status";
const STALE_HOURS = 20;

// USDS proxy (UUPS / ERC-1967)
const USDS_PROXY = "0xdC035D45d973E3EC169d2276DDab16f1e407384F";
// ERC-1967 implementation storage slot
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
// Known implementations without freeze functionality.
// Each address was verified by calling isBlocked(address(0)) on the proxy and
// confirming the call reverts (no freeze capability). Add future safe
// implementations here to avoid an unnecessary probe call per cron cycle.
// Verified at block 22642000 (2025-06-10) via Etherscan:
//   https://etherscan.io/address/0x1923dfee706a8e78157416c29cbccfde7cdf4102
const NO_FREEZE_IMPLS = new Set<string>([
  "0x1923dfee706a8e78157416c29cbccfde7cdf4102",
]);
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
    logWorkerEvent({
      scope: "lib",
      job: "sync-usds-status",
      level: "warn",
      event: "implementation-address-read-failed",
      message: "getImplementationAddress failed",
      error: e,
    });
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
    logWorkerEvent({
      scope: "lib",
      job: "sync-usds-status",
      level: "warn",
      event: "freeze-capability-probe-failed",
      message: "probeFreezeCapability failed",
      error: e,
    });
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
    logWorkerEvent({
      scope: "lib",
      job: "sync-usds-status",
      level: "info",
      event: "cache-fresh",
      message: "Cache still fresh; skipping",
    });
    return createCronResult({ itemCount: 0, metadata: { reason: "cache-fresh" } });
  }

  if (!(await shouldAttemptFetch(db, CIRCUIT_SOURCE.ETHERSCAN))) {
    return createCronResult({ status: "degraded", itemCount: 0, metadata: { reason: "etherscan-circuit-open" } });
  }

  const implementationAddress = await readImplementationSlot(etherscanApiKey, signal);
  if (!implementationAddress) {
    await recordOutcomeSafe(db, CIRCUIT_SOURCE.ETHERSCAN, false);
    logWorkerEvent({
      scope: "lib",
      job: "sync-usds-status",
      level: "warn",
      event: "implementation-slot-unavailable",
      message: "Failed to read implementation slot",
    });
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: { reason: "implementation-slot-unavailable" },
    });
  }

  let freezeCapabilityPresent = false;
  if (!NO_FREEZE_IMPLS.has(implementationAddress)) {
    // Implementation is not in the known-safe set — probe for freeze function
    const probeResult = await probeFreezeCapability(etherscanApiKey, signal);
    if (probeResult === null) {
      await recordOutcomeSafe(db, CIRCUIT_SOURCE.ETHERSCAN, false);
      logWorkerEvent({
        scope: "lib",
        job: "sync-usds-status",
        level: "warn",
        event: "freeze-probe-unavailable",
        message: "Probe failed; preserving cached status",
      });
      return createCronResult({
        status: "degraded",
        itemCount: 0,
        metadata: { reason: "freeze-probe-failed", implementationAddress },
      });
    }
    freezeCapabilityPresent = probeResult;
    logWorkerEvent({
      scope: "lib",
      job: "sync-usds-status",
      level: "info",
      event: "implementation-changed",
      message: "Implementation changed; freeze capability checked",
      metadata: { implementationAddress, freezeCapabilityPresent },
    });
  } else {
    logWorkerEvent({
      scope: "lib",
      job: "sync-usds-status",
      level: "info",
      event: "implementation-unchanged",
      message: "Implementation unchanged; no freeze capability",
    });
  }

  const statusResult = UsdsStatusResponseSchema.safeParse({
    freezeCapabilityPresent,
    implementationAddress,
    lastChecked: syncStartSec,
  });
  if (!statusResult.success) {
    await recordOutcomeSafe(db, CIRCUIT_SOURCE.ETHERSCAN, false);
    logWorkerEvent({
      scope: "lib",
      job: "sync-usds-status",
      event: "status-payload-invalid",
      message: "Status payload validation failed",
      metadata: { issues: statusResult.error.issues },
    });
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: { reason: "status-payload-invalid", implementationAddress, freezeCapabilityPresent },
    });
  }
  const status: UsdsStatusResponse = statusResult.data;

  let cacheResult: CacheWriteResult;
  try {
    cacheResult = await setCacheIfNewer(db, CACHE_KEY, JSON.stringify(status), syncStartSec, signal);
  } catch (err) {
    await recordOutcomeSafe(db, CIRCUIT_SOURCE.ETHERSCAN, true);
    logWorkerEvent({
      scope: "lib",
      job: "sync-usds-status",
      event: "cache-write-failed",
      message: "Cache write failed",
      error: err,
    });
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: { reason: "cache-write-failed", implementationAddress, freezeCapabilityPresent },
    });
  }
  await recordOutcomeSafe(db, CIRCUIT_SOURCE.ETHERSCAN, true);
  logWorkerEvent({
    scope: "lib",
    job: "sync-usds-status",
    level: "info",
    event: cacheResult.written ? "cache-updated" : "cache-update-skipped-newer",
    message: cacheResult.written ? "Cache updated" : "Cache update skipped; newer row exists",
  });
  return createCronResult({
    itemCount: cacheResult.written ? 1 : 0,
    metadata: {
      implementationAddress,
      freezeCapabilityPresent,
      cacheKey: CACHE_KEY,
      syncStartSec,
      cacheWriteMode: cacheResult.written ? "published" : "skipped-newer",
      casSkipped: cacheResult.skippedBecauseNewer,
    },
  });
}
