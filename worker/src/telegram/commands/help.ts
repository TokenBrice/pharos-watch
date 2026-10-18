import { HELP_MESSAGE } from "../webhook/telegram-webhook-shared";
import { buildMiniAppOnlyKeyboard } from "../webhook/telegram-webhook-messages";
import { replyWithOptionalMiniApp, type WebhookCommandHandler } from "./context";

export const handleHelp: WebhookCommandHandler = async (ctx) => {
  await replyWithOptionalMiniApp(
    ctx,
    HELP_MESSAGE,
    buildMiniAppOnlyKeyboard("Open control panel", "settings"),
  );
};
