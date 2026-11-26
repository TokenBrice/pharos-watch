import { cmdForChat } from "../webhook/telegram-webhook-messages";
import { callbackChatType, type CallbackHandler } from "./_shared";

/**
 * Buttons from retired flows (stored confirmations, ticker selection, the
 * /list manage pager, the /timezone picker) still sit in old messages. A tap
 * changes nothing and says where the feature went.
 */
export const handleRetiredButtonCallback: CallbackHandler = async ({ cb, parsed, answerCallback }) => {
  const chatType = callbackChatType(cb);
  const listCmd = cmdForChat("list", chatType);
  const text = parsed.action === "manage" || parsed.action === "unsub"
    ? `This list moved to Manage Alerts. Send ${listCmd} for a summary.`
    : parsed.action === "tz"
      ? "Timezones moved to Manage Alerts."
      : "This button is out of date. Send the command again.";
  await answerCallback({ text });
};
