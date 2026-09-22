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
  /** Identity the record was built under (`buildBlacklistRecordIdentityKey`). */
  key: string;
  stablecoin: BlacklistStablecoin;
  chainId: string;
  address: string;
  blacklistedAt: number;
  destroyedAt: number | null;
  frozenAmountUsd: number | null;
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
): Pick<BlacklistActiveRecord, "frozenAmountUsd"> {
  const currentBalance = findCurrentBalanceSnapshot(event, currentBalances);

  if (currentBalance?.status === "resolved") {
    return { frozenAmountUsd: currentBalance.amountUsd };
  }

  // Tron keeps balances on the contract, so an absent snapshot means the
  // amount is genuinely unknown rather than recoverable from the event.
  if (event.chainId === "tron") {
    return { frozenAmountUsd: null };
  }

  return { frozenAmountUsd: event.amountUsdAtEvent };
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
        key,
        stablecoin: event.stablecoin,
        chainId: event.chainId,
        address: event.address,
        blacklistedAt: event.timestamp,
        destroyedAt: null,
        ...amount,
      });
      continue;
    }

    if (event.eventType === "destroy") {
      const existingKey = findActiveRecordKey(event, active);
      const existing = existingKey ? active.get(existingKey) : undefined;
      if (!existing) continue;
      // The destroy event closes the record; destroyed rows are excluded from
      // every frozen-amount surface, so their amount is left as recorded.
      active.set(existingKey!, {
        ...existing,
        destroyedAt: event.timestamp,
      });
      continue;
    }

    if (event.eventType === "unblacklist") {
      for (const lookupKey of buildBlacklistIdentityLookupKeys(event)) {
        active.delete(lookupKey);
      }
    }
  }

  return [...active.values()].sort((a, b) => (a.blacklistedAt === b.blacklistedAt ? a.key.localeCompare(b.key) : b.blacklistedAt - a.blacklistedAt));
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
