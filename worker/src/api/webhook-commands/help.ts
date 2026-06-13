import { HELP_MESSAGE } from "../telegram-webhook-shared";
import { buildMiniAppOnlyKeyboard } from "../telegram-webhook-messages";
import { replyWithOptionalMiniApp, type WebhookCommandHandler } from "./context";

export const handleHelp: WebhookCommandHandler = async (ctx) => {
  await replyWithOptionalMiniApp(
    ctx,
    HELP_MESSAGE,
    buildMiniAppOnlyKeyboard("Open control panel", "settings"),
  );
};
