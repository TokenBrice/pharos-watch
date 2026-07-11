import type { RoutedSubscriberAlert } from "../dispatch-telegram-routing";
export {
  TELEGRAM_TARGET_PLAN_ENQUEUE_PAGE_SIZE,
  TELEGRAM_TARGET_PLAN_HORIZON_PAGE_SIZE,
  TELEGRAM_TARGET_PLAN_MAX_STEPS_PER_RUN,
} from "@shared/lib/telegram-delivery-policy";

export const TELEGRAM_TARGET_PLAN_CLAIM_TTL_SEC = 120;

export type TelegramPlanningOutcome =
  | "target_planned"
  | "no_matching_scope"
  | "preference_changed_ineligible"
  | "eligible_after_event"
  | "snapshot_missing";

export interface TelegramTargetPlanningClaim {
  sourceEventId: string;
  owner: string;
  generation: number;
  state:
    | "capturing"
    | "planning"
    | "materializing"
    | "ready"
    | "delivery_open"
    | "degraded";
  detectedAt: number;
  expiresAt: number;
  horizonAt: number;
  highWaterChatId: string | null;
  subscriberCursorChatId: string | null;
  planningCursorChatId: string | null;
}

export interface TelegramPlanningSubscriber {
  chatId: string;
  preferenceGeneration: number;
  lastActiveAt: number;
  initiallyEligible: boolean | null;
}

export interface TelegramPlanningDecision {
  subscriber: TelegramPlanningSubscriber;
  currentPreferenceGeneration: number;
  currentEligible: boolean;
  routed: readonly RoutedSubscriberAlert[];
  /** Preserve a legacy overflow target's original absolute TTL when importing it. */
  targetExpiresAt?: number;
}

export function classifyTelegramPlanningOutcome(input: {
  initiallyEligible: boolean | null;
  currentEligible: boolean;
  generationChanged: boolean;
}): TelegramPlanningOutcome {
  if (input.initiallyEligible == null) return "snapshot_missing";
  if (input.currentEligible) {
    return input.initiallyEligible ? "target_planned" : "eligible_after_event";
  }
  if (input.initiallyEligible && input.generationChanged) {
    return "preference_changed_ineligible";
  }
  return "no_matching_scope";
}
