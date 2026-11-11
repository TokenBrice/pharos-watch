import { z } from "zod";

export const TELEGRAM_BROADCAST_SCOPES = ["all", "deliverable-watchers", "global-subscribers"] as const;
export const TELEGRAM_BROADCAST_MESSAGE_HTML_MAX_LENGTH = 16_000;
export const TELEGRAM_PRIVATE_CHAT_ID_PATTERN = /^[1-9]\d*$/;

export const TelegramBroadcastRequestSchema = z.object({
  messageHtml: z.string()
    .refine((value) => value.trim().length > 0, "messageHtml must be a non-empty string")
    .max(TELEGRAM_BROADCAST_MESSAGE_HTML_MAX_LENGTH, `messageHtml must be ${TELEGRAM_BROADCAST_MESSAGE_HTML_MAX_LENGTH.toLocaleString("en-US")} characters or fewer`),
  scope: z.enum(TELEGRAM_BROADCAST_SCOPES, { message: `scope must be one of: ${TELEGRAM_BROADCAST_SCOPES.join(", ")}` }),
  dryRun: z.boolean({ message: "dryRun must be a boolean" }),
  canaryChatId: z.string().regex(TELEGRAM_PRIVATE_CHAT_ID_PATTERN, "canaryChatId must identify a private Telegram chat").optional(),
});

export type TelegramBroadcastRequest = z.output<typeof TelegramBroadcastRequestSchema>;
export type TelegramBroadcastScope = TelegramBroadcastRequest["scope"];
