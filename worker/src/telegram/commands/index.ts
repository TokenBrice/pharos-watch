import type { WebhookCommandHandler } from "./context";
import type { TelegramCanonicalCommand } from "./definitions";
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
import { buildLegacyCommandHandlers } from "./legacy";

export type { WebhookCommandContext, WebhookCommandHandler } from "./context";
export { replyToUnknownCommand } from "./legacy";

/**
 * Dispatch table mapping `/<command>` to its handler. The current commands
 * match `TELEGRAM_COMMAND_REFERENCE` (plus `/sample`, the landing-page
 * `?start=sample` alias); retired commands and aliases come from the legacy
 * map. Anything else gets `replyToUnknownCommand`.
 */
const CANONICAL_COMMAND_HANDLERS: Record<TelegramCanonicalCommand, WebhookCommandHandler> = {
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

export const LEGACY_COMMAND_HANDLERS = buildLegacyCommandHandlers(CANONICAL_COMMAND_HANDLERS);

export const COMMAND_HANDLERS: Record<string, WebhookCommandHandler> = {
  ...LEGACY_COMMAND_HANDLERS,
  ...CANONICAL_COMMAND_HANDLERS,
};
