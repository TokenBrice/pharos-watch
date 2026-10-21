import { THREAT_BAND_ORDER, isThreatBand } from "@shared/lib/classification";
import { TELEGRAM_ALERT_POLICY, crossesTelegramDepegWorseningStep } from "@shared/lib/telegram-delivery-policy";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import {
  isDewsAlertable,
  isDewsDeescalation,
  type ConsolidatedAlerts,
  type DepegWorsening,
  type SafetyChange,
} from "../../../telegram/common/alerts-formatting";
import { isSafetyDeescalation } from "../sources/telegram-alert-snapshots";
import type { SubscriberRow } from "./dispatch-telegram-routing";

export function getSymbol(stablecoinId: string, fallback?: string): string {
  return WORKER_TRACKED_META_BY_ID.get(stablecoinId)?.symbol ?? fallback ?? stablecoinId;
}

export function hasEscalation(alerts: ConsolidatedAlerts): boolean {
  return (
    alerts.dews.some((change) => !isDewsDeescalation(change.oldBand, change.newBand)) ||
    alerts.depegTriggered.length > 0 ||
    alerts.depegWorsening.length > 0 ||
    alerts.safety.some((change) => !isSafetyDeescalation(change.oldGrade, change.newGrade))
  );
}

export function meetsDewsThreshold(newBand: string, minBand: string | null): boolean {
  if (!isDewsAlertable(newBand)) return false;
  if (!minBand || !isThreatBand(minBand) || !isThreatBand(newBand)) return true;
  return THREAT_BAND_ORDER[newBand] >= THREAT_BAND_ORDER[minBand];
}

function shouldIncludeSafetyChange(change: SafetyChange, mode: string | null): boolean {
  if (!mode || mode === "all") return true;
  if (mode === "downgrade-only") return !isSafetyDeescalation(change.oldGrade, change.newGrade);
  if (mode === "upgrade-only") return isSafetyDeescalation(change.oldGrade, change.newGrade);
  return true;
}

function isMaterialSafetyDowngrade(change: SafetyChange): boolean {
  if (isSafetyDeescalation(change.oldGrade, change.newGrade)) return false;
  if (change.oldScore != null && change.newScore != null) {
    return change.oldScore - change.newScore >= TELEGRAM_ALERT_POLICY.safety.globalMinScoreDrop;
  }
  return true;
}


export function meetsDepegStepThreshold(deviationBps: number, step: number | null): boolean {
  if (step == null || step <= 0) return true;
  return deviationBps >= step;
}

/**
 * Live safety is downgrade-only for global and preset coverage alike; only a
 * direct per-coin row (`hasLocalOverride`) applies its own safety mode.
 */
export function shouldIncludeSafetyForSubscriber(sub: SubscriberRow, change: SafetyChange): boolean {
  if (sub.isGlobal) return isMaterialSafetyDowngrade(change);
  return shouldIncludeSafetyChange(change, sub.hasLocalOverride === false ? "downgrade-only" : sub.safety_mode);
}

export function shouldIncludeDepegWorsening(sub: SubscriberRow, event: DepegWorsening): boolean {
  return crossesTelegramDepegWorseningStep(
    event.previousDeviationBps,
    event.currentDeviationBps,
    sub.depeg_worsening_bps_step,
  );
}
