import { TELEGRAM_LAUNCH_RETIRED_MESSAGE } from "@shared/lib/telegram-alert-families";
import { answerCallbackQuery } from "../delivery/telegram";
import { handleSettingsCallback } from "../webhook/telegram-webhook-settings";
import {
  isSettingsWriteSubAction,
  parseSettingsCallback,
} from "../webhook/telegram-webhook-settings-shared";
import {
  requireAdminForMutatingCallback,
  type ParsedCallbackData,
  type TelegramCallbackQuery,
} from "./_shared";

/**
 * Bespoke pre-dispatch entry for `settings:*` callbacks. Validates exact
 * segment counts, allowlisted IDs, coin eligibility, and `0..999` page
 * clamping via the shared policy authority before admin checks or D1 work.
 */
export async function handleSettingsInlineCallback(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  chatId: string,
  parsed: ParsedCallbackData,
): Promise<void> {
  const answer = async (text: string): Promise<void> => {
    await answerCallbackQuery(cb.id, botToken, { text });
  };
  const { arg: subAction = "", parts } = parsed;
  const subArg = parts.slice(2).join(":");
  const validated = parseSettingsCallback(parts);
  if (validated.kind === "invalid") {
    await answer(validated.toast);
    return;
  }
  if (validated.kind === "retired_launch") {
    await answer(TELEGRAM_LAUNCH_RETIRED_MESSAGE);
    return;
  }
  if (
    isSettingsWriteSubAction(subAction) &&
    !(await requireAdminForMutatingCallback(db, botToken, cb, chatId))
  ) {
    return;
  }
  await handleSettingsCallback(db, botToken, cb, subAction, subArg);
}
