import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { ResolvedCoin } from "../lib/telegram-alerts";
import type { TelegramWebhookOperationIntent } from "./telegram-webhook-store";
import { dedupeCoins } from "./telegram-webhook-parsing";
import type { ParsedSetCommand, PendingAction } from "./telegram-webhook-shared";
import { makeActionRunner } from "./webhook-commands/action-runner";

type SelectablePendingAction = Exclude<PendingAction, { actionType: "confirm-bulk" | "forget-confirm" }>;

export type NormalizedPendingSelection =
  | {
      actionType: "subscribe";
      alertTypes: string[];
      presetIds: string[];
      depegWorseningBpsStep?: 100 | 250 | 500 | null;
      initialCoinIds: string[];
      remainingTickers: string[];
      initiatorUserId: string | null;
      clearPending: boolean;
    }
  | {
      actionType: "unsubscribe";
      presetIds: string[];
      initialCoinIds: string[];
      remainingTickers: string[];
      initiatorUserId: string | null;
      clearPending: boolean;
    }
  | {
      actionType: "set";
      command: ParsedSetCommand;
      initialCoinIds: string[];
      remainingTickers: string[];
      initiatorUserId: string | null;
      clearPending: boolean;
    };

export interface PendingSelectionOperationContext {
  beforeIrreversibleEffect?: (kind: string) => Promise<void>;
  planIntent?: (intent: TelegramWebhookOperationIntent) => Promise<void>;
  prepareMutationAppliedStatement?: () => D1PreparedStatement;
  preparePendingMutationAppliedStatement?: (input: {
    chatId: string;
    actionType: string;
    actionPayload: string;
    expiresAt: number;
  }) => D1PreparedStatement;
  confirmAtomicMutationApplied?: () => void;
  markMutationApplied?: () => Promise<void>;
  storedIntent?: TelegramWebhookOperationIntent | null;
  wasMutationApplied?: boolean;
  operationNowSec?: number;
}

function normalizedTicker(value: string): string {
  const ticker = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(ticker)) {
    throw new Error("Pending Telegram selection contains an invalid normalized ticker");
  }
  return ticker;
}

function normalizePendingDisambiguationSelection(
  pending: SelectablePendingAction,
  selectedIndices: readonly number[],
): NormalizedPendingSelection {
  const selectedCoins = dedupeCoins(
    selectedIndices.map((index) => pending.candidates[index]).filter((coin): coin is ResolvedCoin => Boolean(coin)),
  );
  const initialCoinIds = dedupeCoins([...pending.resolvedCoins, ...selectedCoins]).map((coin) => coin.id);
  const remainingTickers = pending.remainingTickers.map(normalizedTicker);
  if (pending.actionType === "subscribe") {
    return {
      actionType: "subscribe",
      alertTypes: [...pending.alertTypes].sort(),
      presetIds: [...pending.presetIds],
      depegWorseningBpsStep: pending.depegWorseningBpsStep,
      initialCoinIds,
      remainingTickers,
      initiatorUserId: pending.initiatorUserId,
      clearPending: true,
    };
  }
  if (pending.actionType === "unsubscribe") {
    return {
      actionType: "unsubscribe",
      presetIds: [...pending.presetIds],
      initialCoinIds,
      remainingTickers,
      initiatorUserId: pending.initiatorUserId,
      clearPending: true,
    };
  }
  return {
    actionType: "set",
    command: pending.command,
    initialCoinIds,
    remainingTickers,
    initiatorUserId: pending.initiatorUserId,
    clearPending: true,
  };
}

function isStoredSetCommand(value: unknown): value is Omit<ParsedSetCommand, "ticker"> {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return false;
  const setting = value as Record<string, unknown>;
  if (typeof setting.enabled !== "boolean") return false;
  switch (setting.setting) {
    case "dews":
      return setting.minBand === null || setting.minBand === "WARNING" || setting.minBand === "DANGER";
    case "safety":
      return setting.mode === null || setting.mode === "downgrade-only" || setting.mode === "upgrade-only";
    case "launch":
    case "reserve":
    case "depeg":
      return true;
    case "depeg-step":
      return setting.enabled === true
        && (setting.step === null || setting.step === 100 || setting.step === 250 || setting.step === 500);
    default:
      return false;
  }
}

function parseStoredCoinIds(value: unknown): string[] | null {
  if (
    !Array.isArray(value)
    || value.length > 512
    || !value.every((id) => typeof id === "string" && TRACKED_META_BY_ID.has(id))
  ) {
    return null;
  }
  return [...value];
}

function parseStoredInitiatorUserId(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Restore a terminal command operation from its immutable normalized intent.
 * This deliberately does not consult the pending row or rerun ticker/preset
 * resolution, both of which may have changed since the operation was planned.
 */
export function parseStoredCommandSelectionIntent(
  intent: TelegramWebhookOperationIntent | null | undefined,
): NormalizedPendingSelection | null {
  if (!intent || intent.mutation !== "required") return null;
  const payload = intent.payload;
  const coinIds = parseStoredCoinIds(payload.coinIds);
  if (coinIds == null || typeof payload.clearPending !== "boolean") return null;

  if (intent.kind === "command:subscribe") {
    if (
      !Array.isArray(payload.alertTypes)
      || !payload.alertTypes.every((entry) => (
        entry === "dews" || entry === "depeg" || entry === "safety" || entry === "launch"
      ))
      || !Array.isArray(payload.presetIds)
      || !payload.presetIds.every((entry) => typeof entry === "string")
      || !(
        payload.depegWorseningBpsStep === null
        || payload.depegWorseningBpsStep === 100
        || payload.depegWorseningBpsStep === 250
        || payload.depegWorseningBpsStep === 500
      )
    ) {
      return null;
    }
    return {
      actionType: "subscribe",
      alertTypes: [...payload.alertTypes] as string[],
      presetIds: [...payload.presetIds] as string[],
      depegWorseningBpsStep: payload.depegWorseningBpsStep,
      initialCoinIds: coinIds,
      remainingTickers: [],
      initiatorUserId: parseStoredInitiatorUserId(payload.initiatorUserId),
      clearPending: payload.clearPending,
    };
  }

  if (intent.kind === "command:unsubscribe") {
    if (
      !Array.isArray(payload.presetIds)
      || !payload.presetIds.every((entry) => typeof entry === "string")
    ) {
      return null;
    }
    return {
      actionType: "unsubscribe",
      presetIds: [...payload.presetIds] as string[],
      initialCoinIds: coinIds,
      remainingTickers: [],
      initiatorUserId: parseStoredInitiatorUserId(payload.initiatorUserId),
      clearPending: payload.clearPending,
    };
  }

  if (intent.kind === "command:set" && isStoredSetCommand(payload.setting)) {
    const firstCoin = TRACKED_META_BY_ID.get(coinIds[0] ?? "");
    if (!firstCoin) return null;
    return {
      actionType: "set",
      command: { ticker: firstCoin.symbol, ...payload.setting } as ParsedSetCommand,
      initialCoinIds: coinIds,
      remainingTickers: [],
      initiatorUserId: parseStoredInitiatorUserId(payload.initiatorUserId),
      clearPending: payload.clearPending,
    };
  }
  return null;
}

function resolveCoinIds(ids: readonly string[]): ResolvedCoin[] {
  return ids.map((id) => {
    const coin = TRACKED_META_BY_ID.get(id);
    if (!coin) throw new Error(`Stored Telegram intent references unknown coin ${id}`);
    return { id, symbol: coin.symbol, name: coin.name };
  });
}

export async function executeNormalizedPendingSelection(
  db: D1Database,
  botToken: string,
  chatId: string,
  username: string | null,
  normalized: NormalizedPendingSelection,
  operation: PendingSelectionOperationContext = {},
): Promise<void> {
  const initialCoins = resolveCoinIds(normalized.initialCoinIds);
  const sharedContext = {
    db,
    chatId,
    username,
    initiatorUserId: normalized.initiatorUserId,
    ...operation,
  };
  if (normalized.actionType === "subscribe") {
    const alertTypes = new Set(normalized.alertTypes);
    const runAction = makeActionRunner(sharedContext, botToken, {
      kind: "subscribe",
      alertTypes: normalized.alertTypes,
      presetIds: normalized.presetIds,
      depegWorseningBpsStep: normalized.depegWorseningBpsStep,
    });
    await runAction({
      tickers: normalized.remainingTickers,
      initialCoins,
      clearPendingOnTerminal: normalized.clearPending,
      actionType: "subscribe",
      actionPayload: {
        alertTypes: normalized.alertTypes,
        presetIds: normalized.presetIds,
        depegWorseningBpsStep: normalized.depegWorseningBpsStep,
      },
      alertTypes,
    });
    return;
  }
  if (normalized.actionType === "unsubscribe") {
    const runAction = makeActionRunner(
      { ...sharedContext, username: null },
      botToken,
      { kind: "unsubscribe", presetIds: normalized.presetIds },
    );
    await runAction({
      tickers: normalized.remainingTickers,
      initialCoins,
      clearPendingOnTerminal: normalized.clearPending,
      actionType: "unsubscribe",
      actionPayload: { presetIds: normalized.presetIds },
      resolutionScope: "tracked",
    });
    return;
  }
  const runAction = makeActionRunner(sharedContext, botToken);
  await runAction({
    tickers: normalized.remainingTickers,
    initialCoins,
    clearPendingOnTerminal: normalized.clearPending,
    actionType: "set",
    actionPayload: normalized.command,
  });
}

export async function executePendingDisambiguationSelection(
  db: D1Database,
  botToken: string,
  chatId: string,
  username: string | null,
  pending: SelectablePendingAction,
  selectedIndices: readonly number[],
  operation: PendingSelectionOperationContext = {},
): Promise<void> {
  await executeNormalizedPendingSelection(
    db,
    botToken,
    chatId,
    username,
    normalizePendingDisambiguationSelection(pending, selectedIndices),
    operation,
  );
}
