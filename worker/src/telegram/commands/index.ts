import type { WebhookCommandHandler } from "./context";
import { handleStart } from "./start";
import { handleHelp } from "./help";
import { handleSample } from "./sample";
import { handleList } from "./list";
import { handleStatus } from "./status";
import { handleSubscribe } from "./subscribe";
import { handleUnsubscribe } from "./unsubscribe";
import { handleSettings } from "./settings";
import { handlePause } from "./pause";
import { handleForget } from "./forget";
import { LEGACY_COMMAND_HANDLERS } from "./legacy";

export type { WebhookCommandContext, WebhookCommandHandler } from "./context";
export { replyToUnknownCommand } from "./legacy";

/**
 * Dispatch table mapping `/<command>` to its handler. The current commands
 * match `TELEGRAM_COMMAND_REFERENCE` (plus `/sample`, the landing-page
 * `?start=sample` alias); retired commands and aliases come from the legacy
 * map. Anything else gets `replyToUnknownCommand`.
 */
export const COMMAND_HANDLERS: Record<string, WebhookCommandHandler> = {
  ...LEGACY_COMMAND_HANDLERS,
  "/start": handleStart,
  "/status": handleStatus,
  "/list": handleList,
  "/subscribe": handleSubscribe,
  "/settings": handleSettings,
  "/pause": handlePause,
  "/help": handleHelp,
  "/unsubscribe": handleUnsubscribe,
  "/forget": handleForget,
  "/sample": handleSample,
};
