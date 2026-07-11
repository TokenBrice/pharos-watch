/**
 * Shared context, types, and helpers used by every callback handler in
 * `webhook-callbacks/`. Mirrors `webhook-commands/context.ts` plus the
 * cross-handler envelopes (`runCallbackMutation`, `runReadOnlyCoinCallback`)
 * lifted from the legacy single-file callbacks module.
 */

import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  recordTelegramUsageEvent,
  type TelegramUsageEventType,
} from "../../lib/telegram-usage-analytics";
import { logTelegramEvent } from "../../lib/telegram-log";
import { SNOOZE_SECONDS } from "../../lib/telegram-constants";
import { isSubscribableCoin } from "../../lib/telegram-subscription-eligibility";
import { requireGroupAdminForCallback } from "../telegram-webhook-auth";
import { createTelegramWebhookIntent } from "../telegram-webhook-effect-fence";
import type { TelegramWebhookOperationIntent } from "../telegram-webhook-store";

export { SNOOZE_SECONDS };

// Allowlist of known callback action codes. Validated at the top of the
// dispatcher so that an unknown action can never reach a D1 read/write.
// `setup` is handled separately above. `confirm`/`cancel` are used by the
// P0-C1 bulk-confirmation gate (action data `confirm:bulk` / `cancel:bulk`).
const CALLBACK_ACTIONS = [
  "snooze",
  "coinsnooze",
  "status",
  "depegstep",
  "safetydown",
  "why",
  "coverage",
  "quicksub",
  "confirm",
  "cancel",
  "manage",
  "unsub",
  "select",
  "help",
  "settings",
  "tz",
  "recap",
] as const;

export type CallbackAction = (typeof CALLBACK_ACTIONS)[number];

export type ParsedCallbackData<TAction extends string = string> = {
  action: TAction;
  arg: string | undefined;
  parts: string[];
};

const KNOWN_ACTIONS = new Set<string>(CALLBACK_ACTIONS);

export type SnoozeArg = keyof typeof SNOOZE_SECONDS;

export function isSnoozeArg(arg: string | undefined): arg is SnoozeArg {
  return arg === "1h" || arg === "4h" || arg === "24h";
}

export function isKnownStablecoinId(id: string | undefined): id is string {
  return typeof id === "string" && TRACKED_META_BY_ID.has(id);
}

export function isSubscribableStablecoinId(id: string | undefined): id is string {
  return isSubscribableCoin(id);
}

export function parseCallbackData(data: string): ParsedCallbackData {
  const parts = data.split(":");
  return { action: parts[0] ?? "", arg: parts[1], parts };
}

export function hasExactParts(parts: readonly string[], expected: number): boolean {
  return parts.length === expected && parts.every((part) => part.length > 0);
}

export function callbackActorUserId(cb: TelegramCallbackQuery): string | null {
  return cb.from?.id != null ? String(cb.from.id) : null;
}

export function callbackChatType(cb: TelegramCallbackQuery): string {
  return cb.message?.chat?.type ?? "private";
}

export function callbackUsername(cb: TelegramCallbackQuery): string | null {
  const chatType = callbackChatType(cb);
  return chatType === "group" || chatType === "supergroup" ? null : cb.from?.username ?? null;
}

export function isKnownCallbackAction(action: string): action is CallbackAction {
  return KNOWN_ACTIONS.has(action);
}

export async function requireAdminForMutatingCallback(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  chatId: string,
  denialText: string = "Only group admins can change alert settings.",
  beforeIrreversibleEffect: (kind: string) => Promise<void> = async () => undefined,
): Promise<boolean> {
  const allowed = await requireGroupAdminForCallback(
    botToken,
    cb.id,
    chatId,
    callbackChatType(cb),
    callbackActorUserId(cb),
    denialText,
    beforeIrreversibleEffect,
  );
  if (!allowed) {
    await recordTelegramUsageEvent(db, {
      eventType: "group_admin_denial",
      actionDetail: cb.data?.split(":")[0] ?? "callback",
      outcome: "denied",
    });
  }
  return allowed;
}

/**
 * Envelope shared by every mutating callback handler:
 *   1. Validate the parsed callback data; if invalid, ack with "Action not
 *      recognized." (or a custom toast) and bail without touching D1.
 *   2. Optionally gate on group-admin status.
 *   3. Run the D1 write inside a try/catch:
 *      - success → record a `recordTelegramUsageEvent("...success")` row and
 *        ack with `successText`.
 *      - failure → `logTelegramEvent`, record `recordTelegramUsageEvent(
 *        "...failure", failureClass: "d1_write_failed")`, ack `failureText`.
 *
 * Per-handler bodies shrink to: validate → write → success text.
 *
 * Outliers that don't fit the envelope (read-only callbacks, callbacks with
 * post-success follow-up messages, callbacks with their own state machine)
 * stay as bespoke handlers.
 */
export async function runCallbackMutation<TValid>(params: {
  db: D1Database;
  botToken: string;
  cb: TelegramCallbackQuery;
  chatId: string;
  /** Return the parsed/validated payload, or `null` to short-circuit with `invalidText`. */
  validate: () => TValid | null;
  /** If true, gate the write on `requireAdminForMutatingCallback`. */
  requireAdmin?: boolean;
  /** Telemetry rows + log envelope. */
  eventType: TelegramUsageEventType;
  actionDetail: string;
  /** `action` field used by `logTelegramEvent` on failure. */
  logAction: string;
  /** First-line message field used by `logTelegramEvent` on failure. */
  logMessage: string;
  /** Outcome label on the success row (defaults to "success"). */
  successOutcome?: string;
  /** D1 write. */
  write: (
    validated: TValid,
    options: { operationStatements?: D1PreparedStatement[] },
  ) => Promise<void>;
  /** Toast text on success. */
  successText: string | ((validated: TValid) => string);
  /** Toast text when validation fails (defaults to "Action not recognized."). */
  invalidText?: string;
  /** Toast text when the D1 write throws. */
  failureText: string;
  answerCallback: (options?: { text?: string }) => Promise<void>;
  beforeIrreversibleEffect: (kind: string) => Promise<void>;
  markMutationApplied: () => Promise<void>;
  planIntent?: (intent: TelegramWebhookOperationIntent) => Promise<void>;
  prepareMutationAppliedStatement?: () => D1PreparedStatement;
  confirmAtomicMutationApplied?: () => void;
  intentKind: string;
  intentPayload: (validated: TValid) => Record<string, unknown>;
  wasMutationApplied?: boolean;
}): Promise<void> {
  const validated = params.validate();
  if (validated == null) {
    await params.answerCallback({
      text: params.invalidText ?? "Action not recognized.",
    });
    return;
  }
  if (
    params.requireAdmin &&
    !(await requireAdminForMutatingCallback(
      params.db,
      params.botToken,
      params.cb,
      params.chatId,
      undefined,
      params.beforeIrreversibleEffect,
    ))
  ) {
    return;
  }
  try {
    await params.planIntent?.(createTelegramWebhookIntent(
      params.intentKind,
      params.intentPayload(validated),
      "required",
    ));
    if (!params.wasMutationApplied) {
      const operationStatements = params.prepareMutationAppliedStatement
        ? [params.prepareMutationAppliedStatement()]
        : undefined;
      await params.write(validated, { operationStatements });
      if (operationStatements) params.confirmAtomicMutationApplied?.();
      // Direct callback unit invocations have no processed-update claim.
      // Production webhook dispatch always supplies the prepared atomic marker.
      else await params.markMutationApplied();
    }
  } catch {
    logTelegramEvent({
      message: params.logMessage,
      action: params.logAction,
    });
    await recordTelegramUsageEvent(params.db, {
      eventType: params.eventType,
      actionDetail: params.actionDetail,
      outcome: "failure",
      failureClass: "d1_write_failed",
    });
    await params.answerCallback({ text: params.failureText });
    return;
  }
  await recordTelegramUsageEvent(params.db, {
    eventType: params.eventType,
    actionDetail: params.actionDetail,
    outcome: params.successOutcome ?? "success",
  });
  const text =
    typeof params.successText === "function"
      ? params.successText(validated)
      : params.successText;
  await params.answerCallback({ text });
}

/**
 * Envelope for read-only coin callbacks (`status:<id>`, `why:<id>`,
 * `coverage:<id>`) that share the same shape:
 *   1. Validate `<id>` against the tracked allowlist; bail with "Action not
 *      recognized." otherwise.
 *   2. Run a `send` callback that posts the card (may throw — the ack still
 *      fires in the `finally`, see P1.16).
 *   3. Ack with a fixed "X sent." toast.
 */
export async function runReadOnlyCoinCallback(params: {
  botToken: string;
  cb: TelegramCallbackQuery;
  parsed: ParsedCallbackData;
  send: (id: string, isPrivateChat: boolean) => Promise<void>;
  ackText: string;
  answerCallback: (options?: { text?: string }) => Promise<void>;
  planIntent?: (intent: TelegramWebhookOperationIntent) => Promise<void>;
  intentKind: string;
}): Promise<void> {
  const { arg, parts } = params.parsed;
  if (!hasExactParts(parts, 2) || !isKnownStablecoinId(arg)) {
    await params.answerCallback({ text: "Action not recognized." });
    return;
  }
  const isPrivateChat = callbackChatType(params.cb) === "private";
  await params.planIntent?.(createTelegramWebhookIntent(params.intentKind, { coinId: arg }));
  try {
    await params.send(arg, isPrivateChat);
  } finally {
    await params.answerCallback({ text: params.ackText });
  }
}

export interface TelegramCallbackQuery {
  id: string;
  data?: string;
  from?: { id?: number; username?: string };
  message?: { chat?: { id?: number; type?: string }; message_id?: number };
}

/**
 * Context passed to every `CallbackHandler`. The dispatcher resolves `chatId`
 * and validates `parsed.action` against the allowlist before dispatch, so
 * handlers can rely on both being well-formed.
 */
export interface CallbackContext {
  db: D1Database;
  botToken: string;
  cb: TelegramCallbackQuery;
  chatId: string;
  parsed: ParsedCallbackData<CallbackAction>;
  beforeIrreversibleEffect: (kind: string) => Promise<void>;
  answerCallback: (options?: { text?: string }) => Promise<void>;
  markMutationApplied: () => Promise<void>;
  planIntent?: (intent: TelegramWebhookOperationIntent) => Promise<void>;
  prepareMutationAppliedStatement?: () => D1PreparedStatement;
  confirmAtomicMutationApplied?: () => void;
  storedIntent?: TelegramWebhookOperationIntent | null;
  wasMutationApplied?: boolean;
}

export type CallbackHandler = (ctx: CallbackContext) => Promise<void>;
