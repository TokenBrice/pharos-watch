import { answerCallbackQuery } from "../../lib/telegram";
import { handleSettingsCallback, type SettingsWebhookEffect } from "../telegram-webhook-settings";
import {
  requireAdminForMutatingCallback,
  type CallbackHandler,
  type ParsedCallbackData,
  type TelegramCallbackQuery,
} from "./_shared";

/**
 * Bespoke pre-dispatch entry for `settings:*` callbacks. Lives outside the
 * `CALLBACK_HANDLERS` map because its parsed `parts` are validated by an
 * action-specific allowlist instead of `hasExactParts(_, 2)` + a single
 * argument check. The registry's `settings` entry is a no-op kept only to make
 * the `Record<CallbackAction, CallbackHandler>` exhaustive.
 */
export async function handleSettingsInlineCallback(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  chatId: string,
  parsed: ParsedCallbackData,
  effect: SettingsWebhookEffect = { beforeIrreversibleEffect: async () => undefined },
): Promise<void> {
  const { beforeIrreversibleEffect } = effect;
  const answer = async (text: string): Promise<void> => {
    await beforeIrreversibleEffect("callback-ack");
    await answerCallbackQuery(cb.id, botToken, { text });
  };
  const { arg: subAction = "", parts } = parsed;
  const subArg = parts.slice(2).join(":");
  // `settings:c` uses colon delimiters; registry tests pin stablecoin ids to
  // the colon-free slug format so the action-specific split remains safe.
  const validSettingsCallback =
    (subAction === "home" && (parts.length === 2 || (parts.length === 3 && /^\d+$/.test(parts[2] ?? "")))) ||
    ((subAction === "gt" || subAction === "q" || subAction === "o") && parts.length === 3) ||
    (subAction === "sc" && parts.length === 2) ||
    (subAction === "c" && parts.length === 5);
  if (!validSettingsCallback) {
    await answer("Action not recognized.");
    return;
  }
  const mutatingSettingsCallback =
    subAction === "gt" ||
    subAction === "q" ||
    subAction === "sc" ||
    subAction === "c";
  if (
    mutatingSettingsCallback &&
    !(await requireAdminForMutatingCallback(db, botToken, cb, chatId, undefined, beforeIrreversibleEffect))
  ) {
    return;
  }
  await handleSettingsCallback(db, botToken, cb, subAction, subArg, effect);
}

// The `settings` action runs through `handleSettingsInlineCallback` *before*
// the registry lookup in `handleCallbackQuery`. This no-op exists only so the
// `Record<CallbackAction, CallbackHandler>` map stays exhaustive over the
// `CallbackAction` union, and is unreachable in practice.
export const handleSettingsCallbackEntry: CallbackHandler = async () => undefined;
