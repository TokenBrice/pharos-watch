import { TELEGRAM_ALERT_PERSISTENCE } from "@shared/lib/telegram-alert-families";
import { TELEGRAM_ALERT_TYPES } from "@shared/types/status/telegram";

// SQL identifiers come only from the canonical persistence manifest, never request data.

/** Families that preset subscriptions can activate. Presets stay DEWS/depeg/safety only. */
const PRESET_ALERT_TYPES = ["dews", "depeg", "safety"] as const;

function activeFlagConditions(columns: readonly string[]): string {
  return columns.map((column) => `${column} = 1`).join("\n  OR ");
}

export const ACTIVE_SUBSCRIPTION_FLAGS_SQL = activeFlagConditions(
  TELEGRAM_ALERT_TYPES.map((alertType) => TELEGRAM_ALERT_PERSISTENCE[alertType].subscriptionColumn),
);

export const ACTIVE_PRESET_FLAGS_SQL = activeFlagConditions(
  PRESET_ALERT_TYPES.map((alertType) => TELEGRAM_ALERT_PERSISTENCE[alertType].subscriptionColumn),
);

/** Requires subscriber alias s and active-count aliases sub and preset. */
export const ACTIVE_WATCHER_SQL_CONDITION = `${
  activeFlagConditions(
    TELEGRAM_ALERT_TYPES.map((alertType) => `s.${TELEGRAM_ALERT_PERSISTENCE[alertType].globalColumn}`),
  )
}
  OR COALESCE(sub.active_sub_count, 0) > 0
  OR COALESCE(preset.active_preset_count, 0) > 0`;
