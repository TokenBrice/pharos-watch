import {
  TELEGRAM_WEBHOOK_INTENT_VERSION,
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
