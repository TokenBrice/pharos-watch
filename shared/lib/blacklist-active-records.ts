import {
  buildBlacklistAddressCountKey,
  buildBlacklistContractBalanceKey,
} from "./blacklist";
import type { BlacklistEvent, BlacklistStablecoin } from "../types/market";

export interface BlacklistCurrentBalanceSnapshot {
  id?: string;
  stablecoin: BlacklistStablecoin;
  chainId: string;
  address: string;
  configKey?: string | null;
  contractAddress?: string | null;
  amountNative: number | null;
  amountUsd: number | null;
  status: "resolved" | "provider_failed";
  source: string;
  observedAt: number;
  lastSuccessfulObservedAt?: number | null;
  lastAttemptedAt?: number | null;
  lastErrorClass?: string | null;
  consecutiveFailures?: number;
}

export interface BlacklistActiveRecord {
  id: string;
  stablecoin: BlacklistStablecoin;
  chainId: string;
  chainName: string;
  address: string;
  configKey?: string | null;
  contractAddress?: string | null;
  blacklistedAt: number;
  blacklistTxHash: string;
  destroyedAt: number | null;
  destroyTxHash: string | null;
  frozenAmountNative: number | null;
  frozenAmountUsd: number | null;
  amountStatus: "resolved" | "provider_failed";
  amountSource: string;
}

export interface BlacklistActiveSummaryStats {
  activeAddressCount: number;
  activeFrozenTotal: number;
  activeAmountGapCount: number;
}

export interface BlacklistTrackedSummaryStats {
  trackedAddressCount: number;
  trackedFrozenTotal: number;
  trackedAmountGapCount: number;
}

function buildBlacklistContractScopedKey(input: {
  stablecoin: BlacklistStablecoin;
  chainId: string;
  address: string;
  configKey?: string | null;
  contractAddress?: string | null;
}): string | null {
  if (!input.configKey && !input.contractAddress) return null;
  return buildBlacklistContractBalanceKey(
    input.stablecoin,
    input.chainId,
    input.address,
    input.configKey,
    input.contractAddress,
  );
}

export function buildBlacklistRecordIdentityKey(input: {
  stablecoin: BlacklistStablecoin;
  chainId: string;
  address: string;
  configKey?: string | null;
  contractAddress?: string | null;
}): string {
  return buildBlacklistContractScopedKey(input)
    ?? buildBlacklistAddressCountKey(input.stablecoin, input.chainId, input.address);
}

export function buildBlacklistIdentityLookupKeys(input: {
  stablecoin: BlacklistStablecoin;
  chainId: string;
  address: string;
  configKey?: string | null;
  contractAddress?: string | null;
}): string[] {
  const scoped = buildBlacklistContractScopedKey(input);
  const legacy = buildBlacklistAddressCountKey(input.stablecoin, input.chainId, input.address);
  return scoped && scoped !== legacy ? [scoped, legacy] : [legacy];
}

function findCurrentBalanceSnapshot(
  event: BlacklistEvent,
  currentBalances: ReadonlyMap<string, BlacklistCurrentBalanceSnapshot>,
): BlacklistCurrentBalanceSnapshot | undefined {
  for (const key of buildBlacklistIdentityLookupKeys(event)) {
    const snapshot = currentBalances.get(key);
    if (snapshot) return snapshot;
  }
  return undefined;
}

function findActiveRecordKey(
  event: BlacklistEvent,
  active: ReadonlyMap<string, BlacklistActiveRecord>,
): string | null {
  for (const key of buildBlacklistIdentityLookupKeys(event)) {
    if (active.has(key)) return key;
  }
  return null;
}

function resolveBlacklistAmount(
  event: BlacklistEvent,
  currentBalances: ReadonlyMap<string, BlacklistCurrentBalanceSnapshot>,
): Pick<BlacklistActiveRecord, "frozenAmountNative" | "frozenAmountUsd" | "amountStatus" | "amountSource"> {
  const currentBalance = findCurrentBalanceSnapshot(event, currentBalances);

  if (currentBalance?.status === "resolved") {
    return {
      frozenAmountNative: currentBalance.amountNative,
      frozenAmountUsd: currentBalance.amountUsd,
      amountStatus: currentBalance.status,
      amountSource: currentBalance.source,
    };
  }

  if (event.chainId === "tron") {
    return {
      frozenAmountNative: null,
      frozenAmountUsd: null,
      amountStatus: currentBalance?.status ?? "provider_failed",
      amountSource: currentBalance?.source ?? "unavailable",
    };
  }

  return {
    frozenAmountNative: event.amountNative,
    frozenAmountUsd: event.amountUsdAtEvent,
    amountStatus: event.amountNative != null || event.amountUsdAtEvent != null ? "resolved" : "provider_failed",
    amountSource: event.amountSource,
  };
}

function resolveDestroyAmount(
  event: BlacklistEvent,
): Pick<BlacklistActiveRecord, "frozenAmountNative" | "frozenAmountUsd" | "amountStatus" | "amountSource"> {
  return {
    frozenAmountNative: event.amountNative,
    frozenAmountUsd: event.amountUsdAtEvent,
    amountStatus: event.amountNative != null || event.amountUsdAtEvent != null ? "resolved" : "provider_failed",
    amountSource: "destroy_event",
  };
}

export function buildBlacklistActiveRecords(
  events: BlacklistEvent[],
  currentBalances: ReadonlyMap<string, BlacklistCurrentBalanceSnapshot> = new Map(),
): BlacklistActiveRecord[] {
  const active = new Map<string, BlacklistActiveRecord>();
  const ordered = [...events].sort((a, b) => (a.timestamp === b.timestamp ? a.id.localeCompare(b.id) : a.timestamp - b.timestamp));

  for (const event of ordered) {
    const key = buildBlacklistRecordIdentityKey(event);
    if (event.eventType === "blacklist") {
      const amount = resolveBlacklistAmount(event, currentBalances);
      active.set(key, {
        id: key,
        stablecoin: event.stablecoin,
        chainId: event.chainId,
        chainName: event.chainName,
        address: event.address,
        configKey: event.configKey,
        contractAddress: event.contractAddress,
        blacklistedAt: event.timestamp,
        blacklistTxHash: event.txHash,
        destroyedAt: null,
        destroyTxHash: null,
        ...amount,
      });
      continue;
    }

    if (event.eventType === "destroy") {
      const existingKey = findActiveRecordKey(event, active);
      const existing = existingKey ? active.get(existingKey) : undefined;
      if (!existing) continue;
      const amount = resolveDestroyAmount(event);
      active.set(existingKey!, {
        ...existing,
        destroyedAt: event.timestamp,
        destroyTxHash: event.txHash,
        ...amount,
      });
      continue;
    }

    if (event.eventType === "unblacklist") {
      for (const lookupKey of buildBlacklistIdentityLookupKeys(event)) {
        active.delete(lookupKey);
      }
    }
  }

  return [...active.values()].sort((a, b) => (a.blacklistedAt === b.blacklistedAt ? a.id.localeCompare(b.id) : b.blacklistedAt - a.blacklistedAt));
}

export function computeBlacklistActiveSummaryStats(
  activeRecords: BlacklistActiveRecord[],
): BlacklistActiveSummaryStats {
  let activeFrozenTotal = 0;
  let activeAmountGapCount = 0;

  for (const record of activeRecords) {
    // Destroyed funds are no longer frozen — exclude from the frozen total
    // and gap counts. Only count toward activeAddressCount (set below from
    // array length) so the ledger retains a record of all blacklisted addresses.
    if (record.destroyedAt != null) continue;
    if (record.frozenAmountUsd == null) {
      activeAmountGapCount++;
      continue;
    }
    activeFrozenTotal += record.frozenAmountUsd;
  }

  return {
    activeAddressCount: activeRecords.length,
    activeFrozenTotal,
    activeAmountGapCount,
  };
}

export function computeBlacklistTrackedSummaryStats(
  currentBalances: ReadonlyMap<string, BlacklistCurrentBalanceSnapshot>,
): BlacklistTrackedSummaryStats {
  let trackedFrozenTotal = 0;
  let trackedAmountGapCount = 0;
  const seen = new Set<string>();

  for (const [key, snapshot] of currentBalances.entries()) {
    const snapshotId = snapshot.id ?? key;
    if (seen.has(snapshotId)) continue;
    seen.add(snapshotId);
    if (snapshot.amountUsd == null) {
      trackedAmountGapCount++;
      continue;
    }
    trackedFrozenTotal += snapshot.amountUsd;
  }

  return {
    trackedAddressCount: seen.size,
    trackedFrozenTotal,
    trackedAmountGapCount,
  };
}
