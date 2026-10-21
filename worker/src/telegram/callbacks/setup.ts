import { answerCallbackQuery } from "../delivery/telegram";
import {
  handleSetupFollowTop,
  handleSetupSample,
  handleSetupUndo,
} from "../webhook/telegram-webhook-setup";
import {
  callbackChatType,
  callbackUsername,
  hasExactParts,
  requireAdminForMutatingCallback,
  type ParsedCallbackData,
  type TelegramCallbackQuery,
} from "./_shared";

/**
 * Bespoke pre-dispatch entry for `setup:*` callbacks (`top25`,
 * `undo:<mask>:<expiry>`, `sample`). A bare `setup:undo` from before the
 * expiry was added carries no prior state, so it gets the restart hint. Buttons from the retired wizard (`setup:branch:…:<flow>` and
 * friends) still sit in old chats; they get a restart hint.
 */
export async function handleSetupCallback(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  chatId: string,
  parsed: ParsedCallbackData,
): Promise<void> {
  const answer = (text: string) => answerCallbackQuery(cb.id, botToken, { text });
  const subAction = hasExactParts(parsed.parts, parsed.arg === "undo" ? 4 : 2) ? parsed.arg : null;
  if (subAction !== "top25" && subAction !== "undo" && subAction !== "sample") {
    await answer("This setup button is out of date. Send /start to begin again.");
    return;
  }
  const context = { db, botToken, chatId, chatType: callbackChatType(cb), username: callbackUsername(cb) };
  if (subAction === "sample") {
    await answer((await handleSetupSample(context)).text);
    return;
  }
  if (!(await requireAdminForMutatingCallback(db, botToken, cb, chatId))) return;
  const result = subAction === "top25"
    ? await handleSetupFollowTop(context)
    : await handleSetupUndo(context, parsed.parts[2], parsed.parts[3]);
  await answer(result.text);
}
