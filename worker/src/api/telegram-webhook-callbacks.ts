/**
 * callback_query router for inline-keyboard taps.
 *
 * Data format: `action:arg` (≤64 bytes per the Bot API limit).
 * Currently supported:
 *   - `snooze:1h | 4h | 24h` — sets alert_snooze_until_ts on telegram_subscribers
 *   - `coinsnooze:<stablecoinId>:1h | 4h | 24h` — sets alert_snooze_until_ts
 *     on the matching telegram_subscriptions row for per-coin snooze (P1-U10)
 *   - `status:<stablecoinId>` — sends the current one-coin status card
 *   - `depegstep:<stablecoinId>:250` — enables per-coin depeg worsening alerts
 *   - `safetydown:<stablecoinId>` — enables per-coin safety downgrade-only alerts
 *   - `why:<stablecoinId>` — sends the safety Why explainer (P1-U11)
 *   - `coverage:<stablecoinId>` — sends the coverage card (P1-U11)
 *   - `quicksub:<stablecoinId>` — enables DEWS+depeg for one coin (P1-U11)
 *   - `manage:page:N` — re-renders the /list management keyboard at page N (P1-U8)
 *   - `unsub:<stablecoinId>` — removes one coin from the chat's subscriptions (P1-U8)
 *   - `select:<N>` — completes a pending ticker disambiguation selection
 *   - `help:commands` — sends the command reference from a recovery button
 *
 * Unknown action codes receive a visible ack and usage telemetry so the bot
 * stays forward-compatible with future keyboard changes.
 *
 * Per-action handlers live in `webhook-callbacks/<action>.ts` and are
 * registered in `webhook-callbacks/index.ts`'s `CALLBACK_HANDLERS` map,
 * mirroring the structure of `webhook-commands/`. This module is the
 * single-import dispatcher entry point.
 */

import { answerCallbackQuery } from "../lib/telegram";
import { recordTelegramUsageEvent } from "../lib/telegram-usage-analytics";
import {
  CALLBACK_HANDLERS,
  type CallbackAction,
  type ParsedCallbackData,
  type TelegramCallbackQuery,
} from "./webhook-callbacks";
import {
  isKnownCallbackAction,
  parseCallbackData,
  SNOOZE_SECONDS,
} from "./webhook-callbacks/_shared";
import type { TelegramWebhookOperationIntent } from "./telegram-webhook-store";
import { handleSetupCallback } from "./webhook-callbacks/setup";
import { handleSettingsInlineCallback } from "./webhook-callbacks/settings";
import {
  TELEGRAM_RECAP_PUBLIC_ROLLOUT_POLICY,
  type TelegramRecapRolloutPolicy,
} from "@shared/lib/telegram-recap-rollout";

// Re-export so any caller importing `SNOOZE_SECONDS` from this module keeps working.
export { SNOOZE_SECONDS };
export type { TelegramCallbackQuery };

export async function handleCallbackQuery(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  effect: {
    beforeIrreversibleEffect: (kind: string) => Promise<void>;
    markMutationApplied: () => Promise<void>;
    planIntent?: (intent: TelegramWebhookOperationIntent) => Promise<void>;
    prepareMutationAppliedStatement?: () => D1PreparedStatement;
    confirmAtomicMutationApplied?: () => void;
    storedIntent?: TelegramWebhookOperationIntent | null;
    wasMutationApplied?: boolean;
    recapRollout?: TelegramRecapRolloutPolicy;
  } = {
    beforeIrreversibleEffect: async () => undefined,
    markMutationApplied: async () => undefined,
  },
): Promise<void> {
  const answer = async (options?: { text?: string }): Promise<void> => {
    await effect.beforeIrreversibleEffect("callback-ack");
    await answerCallbackQuery(cb.id, botToken, options);
  };
  const chatId = cb.message?.chat?.id?.toString();
  if (!chatId) {
    await answer();
    return;
  }

  const parsed = parseCallbackData(cb.data ?? "");

  // `setup` and `settings` run through bespoke pre-dispatch paths that need
  // earlier access to D1 (loading pending-disambiguation state) than the
  // registry-driven path; keep them as direct calls so the registry stays a
  // pure lookup.
  if (parsed.action === "setup") {
    await handleSetupCallback(db, botToken, cb, chatId, parsed, {
      beforeIrreversibleEffect: effect.beforeIrreversibleEffect,
      planIntent: effect.planIntent,
      prepareMutationAppliedStatement: effect.prepareMutationAppliedStatement,
      confirmAtomicMutationApplied: effect.confirmAtomicMutationApplied,
      storedIntent: effect.storedIntent,
      wasMutationApplied: effect.wasMutationApplied,
    });
    return;
  }

  if (parsed.action === "settings") {
    await handleSettingsInlineCallback(db, botToken, cb, chatId, parsed, {
      beforeIrreversibleEffect: effect.beforeIrreversibleEffect,
      planIntent: effect.planIntent,
      prepareMutationAppliedStatement: effect.prepareMutationAppliedStatement,
      confirmAtomicMutationApplied: effect.confirmAtomicMutationApplied,
      storedIntent: effect.storedIntent,
      wasMutationApplied: effect.wasMutationApplied,
    });
    return;
  }

  // Reject unknown actions before any handler can touch D1. Per-action arg
  // validation (isSnoozeArg, isKnownStablecoinId, ...) still runs inside the
  // handler.
  const action = parsed.action;
  if (!isKnownCallbackAction(action)) {
    await recordTelegramUsageEvent(db, {
      eventType: "unknown_command",
      actionDetail: `callback:${action || "unknown"}`,
      outcome: "unknown",
    });
    await answer({ text: "Action not recognized." });
    return;
  }

  const knownParsed: ParsedCallbackData<CallbackAction> = { ...parsed, action };
  const handler = CALLBACK_HANDLERS[knownParsed.action];
  await handler({
    db,
    botToken,
    cb,
    chatId,
    parsed: knownParsed,
    beforeIrreversibleEffect: effect.beforeIrreversibleEffect,
    answerCallback: answer,
    markMutationApplied: effect.markMutationApplied,
    planIntent: effect.planIntent,
    prepareMutationAppliedStatement: effect.prepareMutationAppliedStatement,
    confirmAtomicMutationApplied: effect.confirmAtomicMutationApplied,
    storedIntent: effect.storedIntent,
    wasMutationApplied: effect.wasMutationApplied,
    recapRollout: effect.recapRollout ?? TELEGRAM_RECAP_PUBLIC_ROLLOUT_POLICY,
  });
}
