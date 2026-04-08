import { buildBlacklistAddressCountKey } from "./blacklist";
import type { BlacklistEvent, BlacklistStablecoin } from "../types/market";

export interface BlacklistCurrentBalanceSnapshot {
  stablecoin: BlacklistStablecoin;
  chainId: string;
  address: string;
  amountNative: number | null;
  amountUsd: number | null;
  status: "resolved" | "provider_failed";
  source: string;
  observedAt: number;
}

export interface BlacklistActiveRecord {
  id: string;
  stablecoin: BlacklistStablecoin;
  chainId: string;
  chainName: string;
  address: string;
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

function buildActiveRecordKey(event: Pick<BlacklistEvent, "stablecoin" | "chainId" | "address">): string {
  return buildBlacklistAddressCountKey(event.stablecoin, event.chainId, event.address);
}

function resolveBlacklistAmount(
  event: BlacklistEvent,
  currentBalances: ReadonlyMap<string, BlacklistCurrentBalanceSnapshot>,
): Pick<BlacklistActiveRecord, "frozenAmountNative" | "frozenAmountUsd" | "amountStatus" | "amountSource"> {
  const activeKey = buildActiveRecordKey(event);
  const currentBalance = currentBalances.get(activeKey);

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
    const key = buildActiveRecordKey(event);
    if (event.eventType === "blacklist") {
      const amount = resolveBlacklistAmount(event, currentBalances);
      active.set(key, {
        id: key,
        stablecoin: event.stablecoin,
        chainId: event.chainId,
        chainName: event.chainName,
        address: event.address,
        blacklistedAt: event.timestamp,
        blacklistTxHash: event.txHash,
        destroyedAt: null,
        destroyTxHash: null,
        ...amount,
      });
      continue;
    }

    if (event.eventType === "destroy") {
      const existing = active.get(key);
      if (!existing) continue;
      const amount = resolveDestroyAmount(event);
      active.set(key, {
        ...existing,
        destroyedAt: event.timestamp,
        destroyTxHash: event.txHash,
        ...amount,
      });
      continue;
    }

    if (event.eventType === "unblacklist") {
      active.delete(key);
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

  for (const snapshot of currentBalances.values()) {
    if (snapshot.amountUsd == null) {
      trackedAmountGapCount++;
      continue;
    }
    trackedFrozenTotal += snapshot.amountUsd;
  }

  return {
    trackedAddressCount: currentBalances.size,
    trackedFrozenTotal,
    trackedAmountGapCount,
  };
}
