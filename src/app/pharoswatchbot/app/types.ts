import type { TelegramAlertType } from "@shared/types/status";
export type { TelegramAlertType };
export type TelegramDewsBand = "ALERT" | "WARNING" | "DANGER";
export type TelegramSafetyMode = "all" | "downgrade-only" | "upgrade-only";
export type TelegramDepegStepBps = 100 | 250 | 500;

export interface TelegramMiniAppState {
  viewer: {
    userId: string;
    username: string | null;
    firstName?: string | null;
    chatId: string | null;
    chatType: string | null;
    startParam?: string | null;
    canMutate: boolean;
    mutationBlockReason: "not-private" | "stale-auth" | null;
  };
  subscriber: {
    exists: boolean;
    globalAlerts: Record<TelegramAlertType, boolean> & { depegStepBps: TelegramDepegStepBps | null };
    quietHours: { enabled: boolean; startHourUtc: number | null; endHourUtc: number | null; timezone: string | null };
    snoozeUntilTs: number | null;
  };
  presets: Array<{
    id: string;
    label: string;
    description?: string;
    alertTypes: Pick<Record<TelegramAlertType, boolean>, "dews" | "depeg" | "safety">;
    depegStepBps: TelegramDepegStepBps | null;
  }>;
  subscriptions: Array<{
    stablecoinId: string;
    symbol: string;
    name: string;
    alertTypes: Record<TelegramAlertType, boolean>;
    alertOverrides?: Record<TelegramAlertType, boolean>;
    dewsMinBand: TelegramDewsBand | null;
    depegStepBps: TelegramDepegStepBps | null;
    safetyMode: TelegramSafetyMode | null;
    snoozeUntilTs: number | null;
  }>;
  catalog: {
    recommendedPresets: Array<{ id: string; label: string; description?: string | null }>;
    searchableCoins: Array<{ stablecoinId: string; symbol: string; name: string; peg?: string | null; status?: string | null }>;
  };
  health: {
    lastSuccessfulDeliveryAt: number | null;
    lastSuccessfulReplyAt: number | null;
    queuedAlerts: number;
    recentFailureClass: string | null;
  };
}

export type TelegramSnoozeDurationToken = "1h" | "4h" | "24h";
export type TelegramCoinSnoozeDurationToken = TelegramSnoozeDurationToken | "clear";

export type TelegramMiniAppOperation =
  | { kind: "recommended-setup"; presetId: "usd-top25"; alertTypes: ["dews", "depeg"] }
  | { kind: "set-global"; alertType: TelegramAlertType; enabled: boolean }
  | { kind: "set-global-depeg-step"; depegStepBps: TelegramDepegStepBps | null }
  | { kind: "set-quiet-hours"; enabled: boolean; startHourUtc?: number; endHourUtc?: number }
  | { kind: "clear-snooze" }
  | { kind: "set-snooze"; durationToken: TelegramSnoozeDurationToken }
  | { kind: "pause" }
  | { kind: "set-coin-snooze"; stablecoinId: string; durationToken: TelegramCoinSnoozeDurationToken }
  | { kind: "set-timezone"; timezone: string | null }
  | { kind: "unsubscribe-all" }
  | { kind: "forget-me" }
  | { kind: "set-coin"; stablecoinId: string; patch: { alertTypes?: Partial<Record<TelegramAlertType, boolean>>; dewsMinBand?: TelegramDewsBand | null; depegStepBps?: TelegramDepegStepBps | null; safetyMode?: TelegramSafetyMode | null; launch?: boolean; reserve?: boolean } }
  | { kind: "remove-coin"; stablecoinId: string }
  | { kind: "follow-preset"; presetId: string; alertTypes: Partial<Record<"dews" | "depeg" | "safety", boolean>>; depegStepBps?: TelegramDepegStepBps | null }
  | { kind: "unfollow-preset"; presetId: string };

// Convenience aliases for cross-module sharing between client.tsx, panel components,
// and the mutation hook. The base shape lives in TelegramMiniAppState above.
export type SubscribedCoin = TelegramMiniAppState["subscriptions"][number];
export type CatalogCoin = TelegramMiniAppState["catalog"]["searchableCoins"][number];
export type CoinInsightKind = "why" | "coverage";
export type CoinInsightTarget = { kind: CoinInsightKind; coinId: string };
export type FollowedPreset = TelegramMiniAppState["presets"][number];
