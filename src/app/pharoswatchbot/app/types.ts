export type {
  TelegramAlertType,
  TelegramDepegStepBps,
  TelegramDewsBand,
  TelegramMiniAppActiveDepeg,
  TelegramMiniAppBulkApplyResult,
  TelegramMiniAppBulkWatchlistOperation,
  TelegramMiniAppBulkWatchlistResponse,
  TelegramMiniAppCoinSignal,
  TelegramMiniAppCoinsContext,
  TelegramMiniAppContext,
  TelegramMiniAppContextProvenance,
  TelegramMiniAppContextRequest,
  TelegramMiniAppContextResponse,
  TelegramMiniAppDirectStateProof,
  TelegramMiniAppOperation,
  TelegramMiniAppPresetSummary,
  TelegramMiniAppPresetsContext,
  TelegramMiniAppState,
  TelegramSafetyMode,
  TelegramSnoozeDurationToken,
} from "@shared/lib/telegram-mini-app-contract";

import type { TelegramAlertType, TelegramMiniAppOperation, TelegramMiniAppState } from "@shared/lib/telegram-mini-app-contract";
import type { TelegramPresetAlertType } from "@shared/lib/telegram-alert-families";
import type { TelegramPresetId } from "@shared/lib/telegram-presets";

export type SubscribedCoin = TelegramMiniAppState["subscriptions"][number];
export type CatalogCoin = TelegramMiniAppState["catalog"]["searchableCoins"][number];
export type FollowedPreset = TelegramMiniAppState["presets"][number];
export type CoalescibleMutationOperation = Extract<TelegramMiniAppOperation, { kind: "set-coin" | "follow-preset" }>;

export type MiniAppPrimaryActionKind =
  | "reopen"
  | "retry"
  | "setup"
  | "open-chat"
  | "resume"
  | "follow-coin"
  | "follow-preset"
  | "apply-bulk";

/** The single primary action a screen offers; rendered as the Telegram MainButton. */
export interface MiniAppPrimaryAction {
  kind: MiniAppPrimaryActionKind;
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
  /** Server-enforced burst lockout is counting down (disables even coalescible edits). */
  rateLimited?: boolean;
  pendingOperation: TelegramMiniAppOperation | null;
  /** Coalesced follow-up patch queued behind an in-flight `set-coin` or `follow-preset`. */
  queuedOperation?: CoalescibleMutationOperation | null;
  /** Synchronous intended boolean lookup so rapid double-taps fold against last intent, not confirmed truth. */
  getIntendedCoinValue?: (coinId: string, family: TelegramAlertType, confirmedValue: boolean) => boolean;
  /** Synchronous intended boolean lookup for followed presets. */
  getIntendedPresetValue?: (presetId: TelegramPresetId, family: TelegramPresetAlertType, confirmedValue: boolean) => boolean;
  /** Pre-indexed followed preset membership sets memoized once per state snapshot. */
  presetMemberSetById?: ReadonlyMap<string, ReadonlySet<string>>;
  onMutate: (operation: TelegramMiniAppOperation) => void;
}
