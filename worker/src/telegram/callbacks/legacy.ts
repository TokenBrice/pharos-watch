import type { CallbackHandler } from "./_shared";

const RETIRED_BUTTON_TEXT: Readonly<Record<string, string>> = {
  manage: "This list moved to Manage Alerts. Send /list for a summary.",
  unsub: "This list moved to Manage Alerts. Send /list for a summary.",
  tz: "Timezones moved to Manage Alerts.",
};

/**
 * Buttons from retired flows (stored confirmations, ticker selection, the
 * /list manage pager, the /timezone picker) still sit in old messages. A tap
 * changes nothing and says where the feature went.
 */
export const handleRetiredButtonCallback: CallbackHandler = async ({ parsed, answerCallback }) => {
  await answerCallback({
    text: RETIRED_BUTTON_TEXT[parsed.action] ?? "This button is out of date. Send the command again.",
  });
};
