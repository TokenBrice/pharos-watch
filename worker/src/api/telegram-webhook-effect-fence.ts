import {
  TELEGRAM_WEBHOOK_INTENT_VERSION,
  claimTelegramProcessedUpdate,
  markTelegramProcessedUpdateEffectStarted,
  markTelegramProcessedUpdateFailed,
  markTelegramProcessedUpdateMutationApplied,
  markTelegramProcessedUpdateProcessed,
  prepareTelegramProcessedUpdateMutationApplied,
  prepareTelegramProcessedUpdatePendingMutationApplied,
  recordTelegramProcessedUpdateIntent,
  unixNow,
  type TelegramWebhookOperationIntent,
} from "./telegram-webhook-store";
import { logTelegramEvent } from "../lib/telegram-log";
import {
  resolveUpdateChatId,
  resolveUpdateType,
  type TelegramWebhookUpdateWithChatMember,
} from "./telegram-webhook-update-normalization";

export interface TelegramWebhookClaimToken {
  owner: string;
  generation: number;
}

export function createTelegramWebhookIntent(
  kind: string,
  payload: Record<string, unknown>,
  mutation: "none" | "required" = "none",
): TelegramWebhookOperationIntent {
  return { version: TELEGRAM_WEBHOOK_INTENT_VERSION, kind, mutation, payload };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value == null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function intentsMatch(
  left: TelegramWebhookOperationIntent,
  right: TelegramWebhookOperationIntent,
): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

/**
 * Request-scoped operation coordinator. `planned` is resumable; `started` is
 * the at-most-once boundary and must only be crossed immediately before an
 * irreversible Telegram Bot API request.
 */
export class TelegramWebhookEffectFence {
  private intent: TelegramWebhookOperationIntent | null;
  private mutationApplied: boolean;
  private effectStarted = false;

  constructor(
    private readonly db: D1Database,
    private readonly updateId: number,
    private readonly claim: TelegramWebhookClaimToken,
    storedIntent: TelegramWebhookOperationIntent | undefined,
    mutationAppliedAt: number | null | undefined,
  ) {
    this.intent = storedIntent ?? null;
    this.mutationApplied = mutationAppliedAt != null;
  }

  get storedIntent(): TelegramWebhookOperationIntent | null {
    return this.intent;
  }

  get wasMutationApplied(): boolean {
    return this.mutationApplied;
  }

  get hasStartedEffect(): boolean {
    return this.effectStarted;
  }

  async plan(intent: TelegramWebhookOperationIntent): Promise<void> {
    if (this.intent && !intentsMatch(this.intent, intent)) {
      throw new Error("Telegram retry does not match the stored operation intent");
    }
    await recordTelegramProcessedUpdateIntent(this.db, {
      updateId: this.updateId,
      nowSec: unixNow(),
      claimOwner: this.claim.owner,
      claimGeneration: this.claim.generation,
      intent,
    });
    this.intent = intent;
  }

  async markMutationApplied(): Promise<void> {
    if (this.mutationApplied) return;
    if (!this.intent) throw new Error("Telegram mutation cannot precede operation intent");
    await markTelegramProcessedUpdateMutationApplied(this.db, {
      updateId: this.updateId,
      nowSec: unixNow(),
      claimOwner: this.claim.owner,
      claimGeneration: this.claim.generation,
    });
    this.mutationApplied = true;
  }

  prepareMutationAppliedStatement(nowSec = unixNow()): D1PreparedStatement {
    if (!this.intent || this.intent.mutation !== "required") {
      throw new Error("Telegram operation does not require a mutation marker");
    }
    return prepareTelegramProcessedUpdateMutationApplied(this.db, {
      updateId: this.updateId,
      nowSec,
      claimOwner: this.claim.owner,
      claimGeneration: this.claim.generation,
    });
  }

  preparePendingMutationAppliedStatement(input: {
    chatId: string;
    actionType: string;
    actionPayload: string;
    expiresAt: number;
  }, nowSec = unixNow()): D1PreparedStatement {
    if (!this.intent || this.intent.mutation !== "required") {
      throw new Error("Telegram operation does not require a mutation marker");
    }
    return prepareTelegramProcessedUpdatePendingMutationApplied(this.db, {
      updateId: this.updateId,
      nowSec,
      claimOwner: this.claim.owner,
      claimGeneration: this.claim.generation,
      ...input,
    });
  }

  confirmAtomicMutationApplied(): void {
    this.mutationApplied = true;
  }

  async beforeIrreversibleEffect(effectKind = "telegram-bot-api"): Promise<void> {
    if (!this.intent) {
      await this.plan(createTelegramWebhookIntent(`outbound:${effectKind}`, { effectKind }));
    }
    if (this.intent?.mutation === "required" && !this.mutationApplied) {
      throw new Error("Telegram mutation effect cannot start before the applied marker");
    }
    await markTelegramProcessedUpdateEffectStarted(this.db, {
      updateId: this.updateId,
      nowSec: unixNow(),
      claimOwner: this.claim.owner,
      claimGeneration: this.claim.generation,
      effectKind,
    });
    this.effectStarted = true;
  }

  async finish(errorClass: string | null = null): Promise<void> {
    if (!this.intent) {
      await this.plan(createTelegramWebhookIntent("ingress:no-effect", { disposition: "ignored" }));
    }
    await markTelegramProcessedUpdateProcessed(this.db, {
      updateId: this.updateId,
      nowSec: unixNow(),
      claimOwner: this.claim.owner,
      claimGeneration: this.claim.generation,
      errorClass,
    });
  }

  async fail(errorClass: string | null): Promise<void> {
    await markTelegramProcessedUpdateFailed(this.db, {
      updateId: this.updateId,
      claimOwner: this.claim.owner,
      claimGeneration: this.claim.generation,
      errorClass,
    });
  }
}

/**
 * The fence surface every downstream handler context exposes. Callback
 * handlers, command handlers, the pending-disambiguation gate and the action
 * runner each declare their own (optional) subset of these members; this is the
 * one adapter shape that satisfies all of them.
 *
 * Every member degrades to a no-op when there is no fence (updates without a
 * usable `update_id` proceed fence-less), which is why the callable members are
 * always present while the statement builders are only present with a fence —
 * their callers branch on definedness to decide between an atomic
 * mutation-marker batch and the deferred `markMutationApplied` path.
 */
export interface TelegramMutationOperations {
  beforeIrreversibleEffect: (kind: string) => Promise<void>;
  planIntent: (intent: TelegramWebhookOperationIntent) => Promise<void>;
  prepareMutationAppliedStatement?: () => D1PreparedStatement;
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

export type TelegramMutationContext = Partial<Pick<
  TelegramMutationOperations,
  | "beforeIrreversibleEffect"
  | "planIntent"
  | "prepareMutationAppliedStatement"
  | "confirmAtomicMutationApplied"
  | "storedIntent"
  | "wasMutationApplied"
>>;

export type TelegramPendingWriteContext = TelegramMutationContext & Partial<Pick<
  TelegramMutationOperations,
  "preparePendingMutationAppliedStatement" | "markMutationApplied"
>>;

export type TelegramCommandMutationContext = TelegramPendingWriteContext & Partial<Pick<
  TelegramMutationOperations,
  "prepareMutationOperationStatements"
>>;

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

export interface BuildMutationOperationsOptions {
  /** Crosses the at-most-once boundary; owned by the request, not the fence. */
  beforeIrreversibleEffect: (kind: string) => Promise<void>;
  /**
   * Supplies `prepareMutationOperationStatements` — the command-dispatch path
   * folds a pending-disambiguation delete into the same atomic batch as the
   * mutation marker. Omit it everywhere else: `prepareActionMutation` prefers
   * this builder over the plain marker whenever it is defined, so defining it
   * on a context that does not want the fold would change the emitted SQL.
   */
  mutationOperationStatements?: (fence: TelegramWebhookEffectFence) => D1PreparedStatement[];
}

/**
 * One adapter from the effect fence to the handler-facing operation shape,
 * replacing the hand-written `effectFence ? () => effectFence.x() : undefined`
 * blocks that each dispatch branch used to spell out.
 */
export function buildMutationOperations(
  effectFence: TelegramWebhookEffectFence | null,
  options: BuildMutationOperationsOptions,
): TelegramMutationOperations {
  const mutationOperationStatements = options.mutationOperationStatements;
  return {
    beforeIrreversibleEffect: options.beforeIrreversibleEffect,
    planIntent: async (intent) => effectFence?.plan(intent),
    prepareMutationAppliedStatement: effectFence
      ? () => effectFence.prepareMutationAppliedStatement()
      : undefined,
    preparePendingMutationAppliedStatement: effectFence
      ? (input) => effectFence.preparePendingMutationAppliedStatement(input)
      : undefined,
    prepareMutationOperationStatements: effectFence && mutationOperationStatements
      ? () => mutationOperationStatements(effectFence)
      : undefined,
    confirmAtomicMutationApplied: () => effectFence?.confirmAtomicMutationApplied(),
    markMutationApplied: async () => effectFence?.markMutationApplied(),
    storedIntent: effectFence?.storedIntent ?? null,
    wasMutationApplied: effectFence?.wasMutationApplied ?? false,
  };
}

export type TelegramWebhookUpdateClaimOutcome =
  | { kind: "respond"; response: Response }
  | { kind: "proceed"; effectFence: TelegramWebhookEffectFence | null };

/**
 * Owner/generation-claim the update id and construct the request-scoped effect
 * fence. Duplicate or in-flight updates are answered here without replay;
 * updates without a usable id proceed fence-less.
 */
export async function establishTelegramWebhookEffectFence(
  db: D1Database,
  update: TelegramWebhookUpdateWithChatMember,
  nowSec: number,
): Promise<TelegramWebhookUpdateClaimOutcome> {
  const updateId = update.update_id;
  const claimedUpdateId =
    typeof updateId === "number" && Number.isFinite(updateId) ? updateId : null;
  if (claimedUpdateId == null) {
    return { kind: "proceed", effectFence: null };
  }
  const claim = await claimTelegramProcessedUpdate(db, {
    updateId: claimedUpdateId,
    nowSec,
    updateType: resolveUpdateType(update),
    chatId: resolveUpdateChatId(update),
  });
  if (claim.status !== "claimed") {
    if (claim.status === "in_flight") {
      logTelegramEvent({
        level: "warn",
        message: "duplicate update still in flight",
        action: "processed-update-dedupe",
        retryAfterSec: claim.retryAfterSec ?? null,
      });
      return {
        kind: "respond",
        response: new Response("retry", {
          status: 503,
          headers: {
            "Retry-After": String(Math.max(1, Math.ceil(claim.retryAfterSec ?? 1))),
          },
        }),
      };
    }
    if (claim.status === "effect_unknown") {
      logTelegramEvent({
        level: "warn",
        message: "duplicate update suppressed after effect execution started",
        action: "processed-update-effect-unknown",
      });
    }
    return { kind: "respond", response: new Response("ok", { status: 200 }) };
  }
  if (!claim.claimOwner || claim.claimGeneration == null) {
    throw new Error("Telegram update claim token is missing");
  }
  const processedUpdateClaim = {
    owner: claim.claimOwner,
    generation: claim.claimGeneration,
  };
  return {
    kind: "proceed",
    effectFence: new TelegramWebhookEffectFence(
      db,
      claimedUpdateId,
      processedUpdateClaim,
      claim.storedIntent,
      claim.mutationAppliedAt,
    ),
  };
}
