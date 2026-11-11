import { DEPEG_THRESHOLD_BPS, DEPEG_THRESHOLD_BPS_NON_USD, DEPEG_RECOVERY_THRESHOLD_RATIO } from "@shared/lib/depeg-config";


/** Maximum open depeg events materialized by one detection, confirmation, or orphan-cleanup pass. */
export const MAX_OPEN_DEPEG_EVENTS = 200;

/** Returns the appropriate depeg threshold for a given peg type */
export function getDepegThresholdBps(pegType: string | undefined): number {
  return pegType === "peggedUSD" ? DEPEG_THRESHOLD_BPS : DEPEG_THRESHOLD_BPS_NON_USD;
}

export function getDepegThresholdBpsForPegCurrency(pegCurrency: string | undefined): number {
  return getDepegThresholdBps(pegCurrency === "USD" ? "peggedUSD" : undefined);
}

export function getDepegRecoveryThresholdBps(pegType: string | undefined): number {
  return Math.round(getDepegThresholdBps(pegType) * DEPEG_RECOVERY_THRESHOLD_RATIO);
}

