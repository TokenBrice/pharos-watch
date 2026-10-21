import { TELEGRAM_BOT_USERNAME } from "@shared/lib/telegram-bot-registration";
import { buildManageAlertsKeyboard } from "../webhook/telegram-webhook-messages";
import { replyWithOptionalMiniApp, type WebhookCommandHandler } from "./context";

const HELP_ROWS: ReadonlyArray<readonly [section: string | null, command: string, meaning: string]> = [
  ["Check", "/status", "your alerts and active depegs"],
  [null, "/status USDC", "peg, stress and Safety grade for one coin"],
  [null, "/list", "what you follow"],
  ["Change", "/subscribe USDC USDT", "follow coins, or a preset like usd-top25"],
  [null, "/unsubscribe USDC", "stop following a coin"],
  [null, "/pause 4h", "hold all alerts (/pause off to resume)"],
  [null, "/settings", "alert settings"],
];

/** Every command `/help` names; a registration test keeps this in sync with the menu. */
export const HELP_COMMANDS = ["status", "list", "subscribe", "unsubscribe", "pause", "settings", "forget"] as const;

function renderRows(addressed: boolean): string {
  return HELP_ROWS.map(([section, command, meaning]) => {
    const [name, ...rest] = command.split(" ");
    const typed = addressed ? [`${name}@${TELEGRAM_BOT_USERNAME}`, ...rest].join(" ") : command;
    return `${section ? `\n<b>${section}</b>\n` : ""}${typed}  ${meaning}`;
  }).join("\n");
}

export const PRIVATE_HELP_MESSAGE = `<b>Pharos Watch help</b>
Most settings live in <b>Manage Alerts</b>, the button by the message box.
${renderRows(false)}

/forget deletes everything Pharos Watch stores about this chat.
Every command: pharos.watch/pharoswatchbot/#manual`;

export const GROUP_HELP_MESSAGE = `<b>Pharos Watch help</b>
Group admins manage this chat's alerts. For your own alerts, message @${TELEGRAM_BOT_USERNAME}.
${renderRows(true)}

Every command: pharos.watch/pharoswatchbot/#manual`;

export function helpMessageForChat(chatType: string): string {
  return chatType === "private" ? PRIVATE_HELP_MESSAGE : GROUP_HELP_MESSAGE;
}

export const handleHelp: WebhookCommandHandler = async (ctx) => {
  await replyWithOptionalMiniApp(ctx, helpMessageForChat(ctx.chatType), buildManageAlertsKeyboard());
};
