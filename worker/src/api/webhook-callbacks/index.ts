import { handleSnoozeCallback } from "./snooze";
import { handleCoinSnoozeCallback } from "./coinsnooze";
import { handleStatusCallback } from "./status";
import { handleWhyCallback } from "./why";
import { handleCoverageCallback } from "./coverage";
import { handleQuickSubCallback } from "./quicksub";
import { handleDepegStepCallback } from "./depegstep";
import { handleSafetyDownCallback } from "./safetydown";
import { handleBulkActionCallback } from "./confirm";
import { handleManageCallback } from "./manage";
import { handleUnsubCallback } from "./unsub";
import { handleSelectCallback } from "./select";
import { handleHelpCallback } from "./help";
import { handleTimezoneCallback } from "./tz";
import { handleRecapCallback } from "./recap";
import type { CallbackAction, CallbackHandler } from "./_shared";

export type { CallbackAction, CallbackHandler, ParsedCallbackData, TelegramCallbackQuery } from "./_shared";

/**
 * Dispatch table mapping each registry-routed `CallbackAction` to its handler.
 * The callback dispatcher looks up the handler here after pre-dispatch routing for
 * the bespoke `setup:*` and `settings:*` paths. Mirrors the structure of
 * `webhook-commands/index.ts`'s `COMMAND_HANDLERS`.
 *
 * `confirm:bulk` / `confirm:forget` and `cancel:bulk` / `cancel:forget` share
 * one handler (`handleBulkActionCallback`) because the dispatch logic across
 * the two prefixes is identical.
 *
 * `settings` is handled before registry lookup by its dedicated sub-dispatcher.
 */
export const CALLBACK_HANDLERS: Record<Exclude<CallbackAction, "settings">, CallbackHandler> = {
  snooze: handleSnoozeCallback,
  coinsnooze: handleCoinSnoozeCallback,
  status: handleStatusCallback,
  why: handleWhyCallback,
  coverage: handleCoverageCallback,
  quicksub: handleQuickSubCallback,
  depegstep: handleDepegStepCallback,
  safetydown: handleSafetyDownCallback,
  confirm: handleBulkActionCallback,
  cancel: handleBulkActionCallback,
  manage: handleManageCallback,
  unsub: handleUnsubCallback,
  select: handleSelectCallback,
  help: handleHelpCallback,
  tz: handleTimezoneCallback,
  recap: handleRecapCallback,
};
