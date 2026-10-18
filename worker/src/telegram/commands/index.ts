import type { WebhookCommandHandler } from "./context";
import { handleStart } from "./start";
import { handlePresets } from "./presets";
import { handleHelp } from "./help";
import { handleSample } from "./sample";
import { handleList } from "./list";
import { handleStatus } from "./status";
import { handleBrief } from "./brief";
import { handleTop } from "./top";
import { handleWhy } from "./why";
import { handleCoverage } from "./coverage";
import { handleHealth } from "./health";
import { handleSubscribe } from "./subscribe";
import { handleUnsubscribe } from "./unsubscribe";
import { handleSet } from "./set";
import { handleSettings } from "./settings";
import { handleMute } from "./mute";
import { handlePause } from "./pause";
import { handleTimezone } from "./timezone";
import { handleUnmuteHours } from "./unmutehours";
import { handleUnsnooze } from "./unsnooze";
import { handleCancel } from "./cancel";
import { handleForget } from "./forget";
import { handleExport } from "./export";
import { handleImport } from "./import";
import { handleRecap } from "./recap";

export type { WebhookCommandContext, WebhookCommandHandler } from "./context";

/**
 * Dispatch table mapping `/<command>` to its handler. The webhook dispatcher
 * looks up the handler here for both the fresh-command path and the
 * pending-disambiguation override path; commands not in this table fall
 * through to the "Unknown command" reply.
 *
 * `/market` is preserved as a deprecated compatibility alias for `/brief`.
 */
export const COMMAND_HANDLERS: Record<string, WebhookCommandHandler> = {
  "/start": handleStart,
  "/presets": handlePresets,
  "/help": handleHelp,
  "/sample": handleSample,
  "/list": handleList,
  "/status": handleStatus,
  "/brief": handleBrief,
  "/market": handleBrief,
  "/top": handleTop,
  "/why": handleWhy,
  "/coverage": handleCoverage,
  "/health": handleHealth,
  "/subscribe": handleSubscribe,
  "/unsubscribe": handleUnsubscribe,
  "/set": handleSet,
  "/settings": handleSettings,
  "/mute": handleMute,
  "/pause": handlePause,
  "/timezone": handleTimezone,
  "/unmutehours": handleUnmuteHours,
  "/unsnooze": handleUnsnooze,
  "/cancel": handleCancel,
  "/forget": handleForget,
  "/export": handleExport,
  "/import": handleImport,
  "/recap": handleRecap,
};
