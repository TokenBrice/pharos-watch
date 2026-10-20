/**
 * Shared constants and types for the /settings inline-keyboard surface
 * (P1-U7). Split out of `telegram-webhook-settings.ts` so the command handler,
 * the render builders, and the mutation helpers can each stay narrow.
 */

import type { SubscriberRow } from "./telegram-webhook-shared";
import { TELEGRAM_ALERT_PERSISTENCE } from "@shared/lib/telegram-alert-families";
import {
  TELEGRAM_ALERT_TYPES,
  isTelegramAlertType,
  type TelegramAlertType,
} from "@shared/types/status";


/** Default UTC quiet-hours window used when the user toggles quiet hours on
 * without specifying a range. Mirrors the typical late-night window; users who
 * want a custom range can still call /mute <start>-<end>. */
export const DEFAULT_QUIET_START_HOUR = 22;
export const DEFAULT_QUIET_END_HOUR = 7;

/** The chat-wide toggles are exactly the canonical alert families, in order. */
export const GLOBAL_ALERT_TYPES = TELEGRAM_ALERT_TYPES;
export type GlobalAlertType = TelegramAlertType;


export function isGlobalAlertType(value: string): value is GlobalAlertType {
  return isTelegramAlertType(value);
}


export function subscriberHasGlobal(subscriber: SubscriberRow | null, type: GlobalAlertType): boolean {
  if (!subscriber) return false;
  return Boolean(subscriber[TELEGRAM_ALERT_PERSISTENCE[type].globalColumn]);
}
