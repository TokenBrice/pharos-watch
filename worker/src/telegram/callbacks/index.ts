import { handleSnoozeCallback } from "./snooze";
import { handleCoinSnoozeCallback } from "./coinsnooze";
import { handleStatusCallback } from "./status";
import { handleQuickSubCallback } from "./quicksub";
import { handleDepegStepCallback } from "./depegstep";
import { handleSafetyDownCallback } from "./safetydown";
import { handleFewerCallback } from "./fewer";
import { handleBulkCallback, handleForgetCallback } from "./confirm";
import { handlePickCallback } from "./pick";
import { handleHelpCallback } from "./help";
import { handleRetiredButtonCallback } from "./legacy";
import type { CallbackAction, CallbackHandler } from "./_shared";

export type { CallbackAction, CallbackHandler, ParsedCallbackData, TelegramCallbackQuery } from "./_shared";

/**
 * Dispatch table mapping each registry-routed `CallbackAction` to its handler.
 * The callback dispatcher looks up the handler here after pre-dispatch routing for
 * the bespoke `setup:*` and `settings:*` paths. Mirrors the structure of
 * `worker/src/telegram/commands/index.ts`'s `COMMAND_HANDLERS`.
 *
 * `why:<id>` and `coverage:<id>` buttons on old /status cards now render the
 * status card; the other retired prefixes answer with a short hint.
 */
export const CALLBACK_HANDLERS: Record<Exclude<CallbackAction, "settings">, CallbackHandler> = {
  snooze: handleSnoozeCallback,
  coinsnooze: handleCoinSnoozeCallback,
  status: handleStatusCallback,
  quicksub: handleQuickSubCallback,
  depegstep: handleDepegStepCallback,
  safetydown: handleSafetyDownCallback,
  fewer: handleFewerCallback,
  pick: handlePickCallback,
  bulk: handleBulkCallback,
  forget: handleForgetCallback,
  help: handleHelpCallback,
  why: handleStatusCallback,
  coverage: handleStatusCallback,
  confirm: handleRetiredButtonCallback,
  cancel: handleRetiredButtonCallback,
  manage: handleRetiredButtonCallback,
  unsub: handleRetiredButtonCallback,
  select: handleRetiredButtonCallback,
  tz: handleRetiredButtonCallback,
};
