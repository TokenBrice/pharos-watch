/**
 * Runtime-neutral rollout contract for personalized Telegram recaps.
 *
 * An unset or malformed mode is deliberately `off`. The allowlist is exact:
 * values are trimmed CSV tokens and are only compared with `Set.has(chatId)`.
 */
const TELEGRAM_RECAP_ROLLOUT_MODES = ["off", "dark", "canary", "public"] as const;

export type TelegramRecapRolloutMode = (typeof TELEGRAM_RECAP_ROLLOUT_MODES)[number];

export interface TelegramRecapRolloutPolicy {
  mode: TelegramRecapRolloutMode;
  allowedChatIds: ReadonlySet<string>;
}

export const TELEGRAM_RECAP_PUBLIC_ROLLOUT_POLICY: TelegramRecapRolloutPolicy = {
  mode: "public",
  allowedChatIds: new Set(),
};

export interface TelegramRecapRolloutEnv {
  TELEGRAM_RECAP_ROLLOUT_MODE?: string;
  TELEGRAM_RECAP_ROLLOUT_CHAT_IDS?: string;
}

function parseExactChatIds(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

function normalizeTelegramRecapRolloutMode(value: string | undefined): TelegramRecapRolloutMode {
  const normalized = value?.trim().toLowerCase();
  return TELEGRAM_RECAP_ROLLOUT_MODES.includes(normalized as TelegramRecapRolloutMode)
    ? normalized as TelegramRecapRolloutMode
    : "off";
}

/** Normalize Worker config once per request/trigger; unset is intentionally safe. */
export function resolveTelegramRecapRolloutPolicy(
  env: TelegramRecapRolloutEnv,
): TelegramRecapRolloutPolicy {
  return {
    mode: normalizeTelegramRecapRolloutMode(env.TELEGRAM_RECAP_ROLLOUT_MODE),
    allowedChatIds: parseExactChatIds(env.TELEGRAM_RECAP_ROLLOUT_CHAT_IDS),
  };
}

function isTelegramRecapChatAllowed(
  policy: TelegramRecapRolloutPolicy,
  chatId: string,
): boolean {
  return policy.mode === "public" || (
    policy.mode === "canary" && policy.allowedChatIds.has(chatId)
  );
}

/** Dark mode deliberately projects all due private recaps, but never queues one. */
export function shouldPlanTelegramRecap(
  policy: TelegramRecapRolloutPolicy,
  chatId: string,
): boolean {
  return policy.mode === "dark" || isTelegramRecapChatAllowed(policy, chatId);
}

export function shouldQueueTelegramRecap(policy: TelegramRecapRolloutPolicy): boolean {
  return policy.mode === "canary" || policy.mode === "public";
}

/** Controls and delivery share the same recipient boundary. */
export function isTelegramRecapAvailableToChat(
  policy: TelegramRecapRolloutPolicy,
  chatId: string,
): boolean {
  return isTelegramRecapChatAllowed(policy, chatId);
}
