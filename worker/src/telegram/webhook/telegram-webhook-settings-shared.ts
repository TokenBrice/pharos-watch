/**
 * Shared constants and types for the /settings inline-keyboard surface
 * (P1-U7). Split out of `telegram-webhook-settings.ts` so the command handler,
 * the render builders, and the mutation helpers can each stay narrow.
 */

import type { SubscriberRow } from "./telegram-webhook-shared";
import { TELEGRAM_ALERT_PERSISTENCE } from "@shared/lib/telegram-alert-families";
import {
  TELEGRAM_LIVE_ALERT_TYPES,
  type TelegramLiveAlertType,
} from "@shared/types/status/telegram";


/** The chat-wide toggles are the live alert families, in order (launch is retired). */
export const GLOBAL_ALERT_TYPES = TELEGRAM_LIVE_ALERT_TYPES;
export type GlobalAlertType = TelegramLiveAlertType;


export function isGlobalAlertType(value: string): value is GlobalAlertType {
  return (GLOBAL_ALERT_TYPES as readonly string[]).includes(value);
}


export function subscriberHasGlobal(subscriber: SubscriberRow | null, type: GlobalAlertType): boolean {
  if (!subscriber) return false;
  return Boolean(subscriber[TELEGRAM_ALERT_PERSISTENCE[type].globalColumn]);
}
