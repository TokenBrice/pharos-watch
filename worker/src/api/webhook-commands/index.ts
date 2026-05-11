import type { WebhookCommandHandler } from "./context";
import { handleStart } from "./start";
import { handlePresets } from "./presets";
import { handleHelp } from "./help";
import { handleList } from "./list";
import { handleStatus } from "./status";
import { handleBrief } from "./brief";
import { handleTop } from "./top";
import { handleWhy } from "./why";
import { handleCoverage } from "./coverage";
import { handleSubscribe } from "./subscribe";
import { handleUnsubscribe } from "./unsubscribe";
import { handleSet } from "./set";
import { handleSettings } from "./settings";
import { handleMute } from "./mute";
import { handleTimezone } from "./timezone";
import { handleUnmuteHours } from "./unmutehours";
import { handleUnsnooze } from "./unsnooze";
import { handleCancel } from "./cancel";

export type { WebhookCommandContext, WebhookCommandHandler } from "./context";

/**
 * Dispatch table mapping `/<command>` to its handler. The webhook dispatcher
 * looks up the handler here for both the fresh-command path and the
 * pending-disambiguation override path; commands not in this table fall
 * through to the "Unknown command" reply.
 *
 * `/market` is preserved as an alias for `/brief` (deprecated; remove in vN+1).
 */
export const COMMAND_HANDLERS: Record<string, WebhookCommandHandler> = {
  "/start": handleStart,
  "/presets": handlePresets,
  "/help": handleHelp,
  "/list": handleList,
  "/status": handleStatus,
  "/brief": handleBrief,
  "/market": handleBrief,
  "/top": handleTop,
  "/why": handleWhy,
  "/coverage": handleCoverage,
  "/subscribe": handleSubscribe,
  "/unsubscribe": handleUnsubscribe,
  "/set": handleSet,
  "/settings": handleSettings,
  "/mute": handleMute,
  "/timezone": handleTimezone,
  "/unmutehours": handleUnmuteHours,
  "/unsnooze": handleUnsnooze,
  "/cancel": handleCancel,
};
