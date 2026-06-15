/**
 * Shared constants and types for the /settings inline-keyboard surface
 * (P1-U7). Split out of `telegram-webhook-settings.ts` so the command handler,
 * the render builders, and the mutation helpers can each stay narrow.
 */

import { isKnownStablecoinId } from "./webhook-callbacks/_shared";
import type { SubscriberRow } from "./telegram-webhook-shared";

export { isKnownStablecoinId };

/** Default UTC quiet-hours window used when the user toggles quiet hours on
 * without specifying a range. Mirrors the typical late-night window; users who
 * want a custom range can still call /mute <start>-<end>. */
export const DEFAULT_QUIET_START_HOUR = 22;
export const DEFAULT_QUIET_END_HOUR = 7;

export const GLOBAL_ALERT_TYPES = ["dews", "depeg", "safety", "launch"] as const;
export type GlobalAlertType = (typeof GLOBAL_ALERT_TYPES)[number];

export const DEWS_BAND_CODES = { A: "ALERT", W: "WARNING", D: "DANGER" } as const;
export type DewsBandCode = keyof typeof DEWS_BAND_CODES;
export type DewsBandValue = (typeof DEWS_BAND_CODES)[DewsBandCode];

export const SAFETY_MODE_CODES = { a: "all", d: "downgrade-only", u: "upgrade-only" } as const;
export type SafetyModeCode = keyof typeof SAFETY_MODE_CODES;
export type SafetyModeValue = (typeof SAFETY_MODE_CODES)[SafetyModeCode];

export const DEPEG_STEPS = [100, 250, 500] as const;
export type DepegStep = (typeof DEPEG_STEPS)[number];

export function isGlobalAlertType(value: string): value is GlobalAlertType {
  return (GLOBAL_ALERT_TYPES as readonly string[]).includes(value);
}

export function isDewsBandCode(value: string): value is DewsBandCode {
  return value === "A" || value === "W" || value === "D";
}

export function isSafetyModeCode(value: string): value is SafetyModeCode {
  return value === "a" || value === "d" || value === "u";
}

export function isDepegStep(value: unknown): value is DepegStep {
  return value === 100 || value === 250 || value === 500;
}

export function subscriberHasGlobal(subscriber: SubscriberRow | null, type: GlobalAlertType): boolean {
  if (!subscriber) return false;
  if (type === "dews") return Boolean(subscriber.global_alert_dews);
  if (type === "depeg") return Boolean(subscriber.global_alert_depeg);
  if (type === "safety") return Boolean(subscriber.global_alert_safety);
  return Boolean(subscriber.global_alert_launch);
}
