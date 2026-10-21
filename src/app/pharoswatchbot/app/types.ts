export type {
  TelegramAlertType,
  TelegramCoinSnoozeDurationToken,
  TelegramDepegStepBps,
  TelegramDewsBand,
  TelegramMiniAppOperation,
  TelegramMiniAppBulkWatchlistOperation,
  TelegramMiniAppBulkWatchlistResponse,
  TelegramMiniAppState,
  TelegramSafetyMode,
  TelegramSnoozeDurationToken,
} from "@shared/lib/telegram-mini-app-contract";

import type { TelegramMiniAppOperation, TelegramMiniAppState } from "@shared/lib/telegram-mini-app-contract";

export type SubscribedCoin = TelegramMiniAppState["subscriptions"][number];
export type CatalogCoin = TelegramMiniAppState["catalog"]["searchableCoins"][number];
export type FollowedPreset = TelegramMiniAppState["presets"][number];

/** The single primary action a screen offers; rendered as the Telegram MainButton. */
export interface MiniAppPrimaryAction {
  text: string;
  onClick: () => void;
  /** Shows the MainButton progress spinner while the action's request runs. */
  progress?: boolean;
}

/** What every editable screen needs from the shell. */
export interface MiniAppScreenProps {
  state: TelegramMiniAppState;
  nowSec: number;
  /** Controls are interactive (also true after stale auth so edits become visible intent). */
  canEdit: boolean;
  /** A request is in flight or the edit rate limit is active. */
  busy: boolean;
  pendingOperation: TelegramMiniAppOperation | null;
  onMutate: (operation: TelegramMiniAppOperation) => void;
}
