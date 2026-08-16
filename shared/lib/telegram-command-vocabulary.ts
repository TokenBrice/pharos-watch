import { TELEGRAM_PRESET_IDS } from "./telegram-presets";
import { TELEGRAM_ALERT_TYPES } from "../types/status/telegram";

const PRESET_COMMAND_TOKENS = TELEGRAM_PRESET_IDS.flatMap((presetId) => {
  const dashedAlias = presetId.replace(/top(\d+)$/, "top-$1");
  return dashedAlias === presetId ? [presetId] : [presetId, dashedAlias];
});

/** Tokens parsed as Telegram command vocabulary rather than stablecoin targets. */
const TELEGRAM_RESERVED_TARGET_TOKENS: ReadonlySet<string> = new Set([
  "all",
  "depeg-step",
  ...TELEGRAM_ALERT_TYPES,
  ...PRESET_COMMAND_TOKENS,
]);

export function isTelegramReservedTargetToken(token: string): boolean {
  return TELEGRAM_RESERVED_TARGET_TOKENS.has(token.toLowerCase());
}
