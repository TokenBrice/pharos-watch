import { logTelegramEvent } from "../lib/telegram-log";
import type { DispatchResult } from "./dispatch-telegram-result";

function isSystemicFreshFailure(result: DispatchResult): boolean {
  return result.freshAttempted > 0 && result.freshSent === 0 && (result.freshRetryQueued > 0 || result.freshPermanentFailures > 0);
}

function logSystemicFreshFailure(result: DispatchResult): void {
  logTelegramEvent({
    level: "error",
    message: "systemic fresh Telegram alert delivery failure",
    action: "dispatch-systemic-fresh-failure",
    module: "dispatch-telegram-alerts",
    attemptedCount: result.freshAttempted,
    sentCount: result.freshSent,
    queuedCount: result.freshRetryQueued,
    permanentFailureCount: result.freshPermanentFailures,
    pendingAttemptedCount: result.pendingAttempted,
    pendingSentCount: result.pendingSent,
    pendingEnqueuedCount: result.pendingEnqueued,
  });
}

export function recordSystemicFreshFailure(result: DispatchResult): boolean {
  const systemicFreshFailure = isSystemicFreshFailure(result);
  if (systemicFreshFailure) logSystemicFreshFailure(result);
  return systemicFreshFailure;
}
