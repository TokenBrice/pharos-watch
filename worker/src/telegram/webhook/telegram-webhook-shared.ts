import { WORKER_TRACKED_STABLECOINS } from "@shared/lib/stablecoins/worker-runtime-registry";
import type { TelegramDewsBand, TelegramSafetyMode } from "@shared/types/status/telegram";
import type { ResolvedCoin } from "../common/alerts-parser";
import type { TelegramChatMemberUpdated } from "./telegram-webhook-group-welcome";
import {
  TELEGRAM_WEBHOOK_INTENT_VERSION,
  type TelegramWebhookOperationIntent,
} from "../store/processed-updates";

export type ParsedSetCommand =
  | { ticker: string; setting: "dews"; enabled: boolean; minBand: TelegramDewsBand | null }
  | { ticker: string; setting: "safety"; enabled: boolean; mode: TelegramSafetyMode | null }
  | { ticker: string; setting: "launch"; enabled: boolean }
  | { ticker: string; setting: "reserve"; enabled: boolean }
  | { ticker: string; setting: "freeze"; enabled: boolean }
  | { ticker: string; setting: "depeg"; enabled: boolean }
  | { ticker: string; setting: "depeg-step"; enabled: true; step: 100 | 250 | 500 | null };

export interface PresetSubscriptionRow {
  preset_id: string;
  alert_dews: number;
  alert_depeg: number;
  alert_safety: number;
  depeg_worsening_bps_step: number | null;
}

export interface TelegramWebhookUpdate {
  update_id?: number;
  message?: {
    chat?: {
      id?: number;
      username?: string;
      type?: "private" | "group" | "supergroup" | "channel" | string;
    };
    from?: {
      id?: number;
      username?: string;
    };
    /** Set when an anonymous group admin (or a linked channel) posts as a chat. */
    sender_chat?: { id?: number };
    text?: string;
    migrate_to_chat_id?: number;
    migrate_from_chat_id?: number;
  };
  callback_query?: {
    id: string;
    data?: string;
    from?: { id?: number; username?: string };
    message?: { chat?: { id?: number; type?: string }; message_id?: number };
  };
}

export type TelegramWebhookUpdateWithChatMember = TelegramWebhookUpdate & {
  my_chat_member?: TelegramChatMemberUpdated;
};

export interface SubscriberRow {
  alert_dews: number;
  alert_depeg: number;
  alert_safety: number;
  alert_launch: number;
  alert_reserve?: number | null;
  alert_freeze?: number | null;
  global_alert_dews?: number | null;
  global_alert_depeg?: number | null;
  global_alert_safety?: number | null;
  global_alert_launch?: number | null;
  global_alert_reserve?: number | null;
  global_alert_freeze?: number | null;
  global_depeg_worsening_bps_step?: number | null;
  quiet_hours_enabled: number | null;
  quiet_hours_start_utc: number | null;
  quiet_hours_end_utc: number | null;
  timezone?: string | null;
  alert_snooze_until_ts?: number | null;
  consecutive_block_count?: number | null;
  consecutive_block_first_at?: number | null;
  preference_generation?: number | null;
}

export interface SubscriptionRow {
  stablecoin_id: string;
  alert_dews: number;
  alert_depeg: number;
  alert_safety: number;
  alert_launch: number;
  alert_reserve?: number | null;
  alert_freeze?: number | null;
  dews_min_band: string | null;
  safety_mode: string | null;
  depeg_worsening_bps_step: number | null;
  alert_snooze_until_ts?: number | null;
  alert_dews_override?: number | null;
  alert_depeg_override?: number | null;
  alert_safety_override?: number | null;
  alert_launch_override?: number | null;
  alert_reserve_override?: number | null;
  alert_freeze_override?: number | null;
}

export const STABLECOIN_BY_ID = new Map<string, ResolvedCoin>(
  WORKER_TRACKED_STABLECOINS.map((coin) => [
    coin.id,
    {
      id: coin.id,
      symbol: coin.symbol,
      name: coin.name,
    },
  ]),
);

// ---------- Legacy handler operation hooks ----------
// Handlers may still accept these optional hooks; the webhook no longer
// supplies any of them (update-id dedupe only), so every handler takes its
// direct path. Removed once no handler references them.

export function createTelegramWebhookIntent(
  kind: string,
  payload: Record<string, unknown>,
  mutation: "none" | "required" = "none",
): TelegramWebhookOperationIntent {
  return { version: TELEGRAM_WEBHOOK_INTENT_VERSION, kind, mutation, payload };
}

export interface TelegramMutationOperations {
  beforeIrreversibleEffect: (kind: string) => Promise<void>;
  planIntent: (intent: TelegramWebhookOperationIntent) => Promise<void>;
  prepareMutationAppliedStatement?: (options?: { requirePreviousChange?: boolean }) => D1PreparedStatement;
  preparePendingMutationAppliedStatement?: (input: {
    chatId: string;
    actionType: string;
    actionPayload: string;
    expiresAt: number;
  }) => D1PreparedStatement;
  prepareMutationOperationStatements?: () => D1PreparedStatement[];
  confirmAtomicMutationApplied: () => void;
  markMutationApplied: () => Promise<void>;
  storedIntent: TelegramWebhookOperationIntent | null;
  wasMutationApplied: boolean;
}

export type TelegramCallbackMutationContext = Pick<
  TelegramMutationOperations,
  "beforeIrreversibleEffect" | "markMutationApplied"
> & Partial<Pick<
  TelegramMutationOperations,
  | "planIntent"
  | "prepareMutationAppliedStatement"
  | "confirmAtomicMutationApplied"
  | "storedIntent"
  | "wasMutationApplied"
>>;
