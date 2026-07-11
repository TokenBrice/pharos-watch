export type {
  TelegramAlertType,
  TelegramCoinSnoozeDurationToken,
  TelegramDepegStepBps,
  TelegramDewsBand,
  TelegramMiniAppOperation,
  TelegramMiniAppBulkWatchlistOperation,
  TelegramMiniAppBulkWatchlistResponse,
  TelegramMiniAppPortabilityOperation,
  TelegramMiniAppPortabilityResponse,
  TelegramMiniAppState,
  TelegramSafetyMode,
  TelegramSnoozeDurationToken,
} from "@shared/lib/telegram-mini-app-contract";

import type { TelegramMiniAppState } from "@shared/lib/telegram-mini-app-contract";

export type SubscribedCoin = TelegramMiniAppState["subscriptions"][number];
export type CatalogCoin = TelegramMiniAppState["catalog"]["searchableCoins"][number];
export type CoinInsightKind = "why" | "coverage";
export type CoinInsightTarget = { kind: CoinInsightKind; coinId: string };
export type FollowedPreset = TelegramMiniAppState["presets"][number];
