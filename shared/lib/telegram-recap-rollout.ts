/**
 * Runtime-neutral rollout contract for personalized Telegram recaps.
 *
 * Unset, malformed, and retired rollout modes deliberately resolve to `off`.
 */
const TELEGRAM_RECAP_ROLLOUT_MODES = ["off", "public"] as const;

export type TelegramRecapRolloutMode = (typeof TELEGRAM_RECAP_ROLLOUT_MODES)[number];

export interface TelegramRecapRolloutPolicy {
  mode: TelegramRecapRolloutMode;
}

export const TELEGRAM_RECAP_PUBLIC_ROLLOUT_POLICY: TelegramRecapRolloutPolicy = {
  mode: "public",
};

export interface TelegramRecapRolloutEnv {
  TELEGRAM_RECAP_ROLLOUT_MODE?: string;
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
  };
}



/** Controls share the public/off boundary with recap delivery. */
export function isTelegramRecapAvailable(
  policy: TelegramRecapRolloutPolicy,
): boolean {
  return policy.mode === "public";
}
