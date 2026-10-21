import type { TelegramPendingCapacitySnapshot } from "../../../telegram/outbox/pending-capacity";

export interface PendingDrainResult {
  attempted: number;
  sent: number;
  /** Exact distinct chats with at least one Bot API-accepted message in this drain. */
  acceptedChats: number;
  blocked: number;
  blockedCleanedUp: number;
  blockedCleanupFailed: number;
  retryQueued: number;
  executionUnknown: number;
  dropped: number;
  /** Drained rows dropped because Telegram returned a non-retryable, non-blocked error. */
  droppedPermanentFailure: number;
  /** Drained rows dropped because the defensive attempts ceiling was hit inside the TTL window. */
  droppedMaxAttemptsFallback: number;
  deferred: number;
  rateLimited: boolean;
  retryAfterSec: number | null;
  notBeforeAt: number | null;
}

export type PendingCapacitySnapshot = TelegramPendingCapacitySnapshot;

export function emptyDrainResult(): PendingDrainResult {
  return {
    attempted: 0,
    sent: 0,
    acceptedChats: 0,
    blocked: 0,
    blockedCleanedUp: 0,
    blockedCleanupFailed: 0,
    retryQueued: 0,
    executionUnknown: 0,
    dropped: 0,
    droppedPermanentFailure: 0,
    droppedMaxAttemptsFallback: 0,
    deferred: 0,
    rateLimited: false,
    retryAfterSec: null,
    notBeforeAt: null,
  };
}
