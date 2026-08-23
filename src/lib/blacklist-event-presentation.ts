import { formatCurrency } from "@shared/lib/format";
import { isGoldBlacklistStablecoin } from "@shared/lib/blacklist";
import type { BlacklistEvent } from "@shared/types";

const AMOUNT_SOURCE_LABELS: Record<string, string> = {
  event: "event",
  historical_balance: "historical",
  current_balance_snapshot: "snapshot",
  derived: "derived",
  legacy_migration: "legacy",
  unavailable: "unavailable",
};

const AMOUNT_STATUS_LABELS: Record<string, string> = {
  recoverable_pending: "pending recovery",
  provider_failed: "provider failed",
  ambiguous: "ambiguous",
  permanently_unavailable: "unavailable",
};

function getBlacklistNativeFractionDigits(event: BlacklistEvent): 2 | 4 {
  return isGoldBlacklistStablecoin(event.stablecoin) ? 4 : 2;
}

export function formatBlacklistNativeAmount(event: BlacklistEvent): string {
  return event.amountNative!.toLocaleString(undefined, {
    maximumFractionDigits: getBlacklistNativeFractionDigits(event),
  });
}

export function getBlacklistAmountSourceLabel(event: BlacklistEvent): string {
  return AMOUNT_SOURCE_LABELS[event.amountSource] ?? event.amountSource.replace(/_/g, " ");
}

export function getBlacklistAmountStatusLabel(event: BlacklistEvent): string {
  return AMOUNT_STATUS_LABELS[event.amountStatus] ?? event.amountStatus.replace(/_/g, " ");
}

export function formatBlacklistAmount(event: BlacklistEvent): string {
  if (event.amountUsdAtEvent != null) return formatCurrency(event.amountUsdAtEvent);
  if (event.amountNative != null && !(event.amountNative === 0 && event.eventType !== "destroy")) {
    return `${formatBlacklistNativeAmount(event)} ${event.stablecoin}`;
  }
  return getBlacklistAmountStatusLabel(event);
}
