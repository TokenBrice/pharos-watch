import {
  PAR_ROUNDOFF_BPS,
  getDepegRecoveryThresholdBps,
  getDepegThresholdBps,
  getDepegThresholdBpsForPegCurrency,
} from "@shared/lib/depeg-config";

/** Maximum open depeg events materialized by one detection, confirmation, or orphan-cleanup pass. */
export const MAX_OPEN_DEPEG_EVENTS = 200;

export {
  getDepegThresholdBps,
  getDepegThresholdBpsForPegCurrency,
  getDepegRecoveryThresholdBps,
};

export function isWithinRecoveryBand(absRawBps: number, recoveryThresholdBps: number): boolean {
  return absRawBps <= recoveryThresholdBps + PAR_ROUNDOFF_BPS;
}
