import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { TelegramMiniAppAuthContext } from "../lib/telegram-mini-app-auth";
import { resolveTelegramPresetTargets, type TelegramPresetId } from "../lib/telegram-presets";
import { DEFAULT_QUIET_END_HOUR, DEFAULT_QUIET_START_HOUR } from "./telegram-webhook-settings-shared";
import { applyCoinSetting, clearSnoozeViaSettings } from "./telegram-webhook-settings-mutations";
import { removePresetSubscriptions, removeSubscriptions, upsertPresetSubscriptions, upsertSubscriberAndSubscriptions, upsertSubscriberRow, unixNow, type UpsertSubscriberInput } from "./telegram-webhook-store";
import type { TelegramMiniAppOperation } from "./telegram-mini-app-schemas";

export type TelegramMiniAppMutationErrorCode = "not-private" | "unknown-coin" | "unknown-preset" | "empty-alert-types" | "preset-unavailable" | "invalid-coin-patch";

export class TelegramMiniAppMutationError extends Error {
  readonly code: TelegramMiniAppMutationErrorCode;
  readonly status: number;

  constructor(code: TelegramMiniAppMutationErrorCode, status = 400) {
    super(code);
    this.name = "TelegramMiniAppMutationError";
    this.code = code;
    this.status = status;
  }
}

const DEWS_BAND_TO_CODE = { ALERT: "A", WARNING: "W", DANGER: "D" } as const;
const SAFETY_MODE_TO_CODE = { all: "a", "downgrade-only": "d", "upgrade-only": "u" } as const;

function privateChatId(auth: TelegramMiniAppAuthContext): string {
  if (!auth.canMutatePrivateChat) throw new TelegramMiniAppMutationError("not-private", 403);
  return auth.userId;
}

function assertCoin(stablecoinId: string): void {
  if (!TRACKED_META_BY_ID.has(stablecoinId)) throw new TelegramMiniAppMutationError("unknown-coin");
}

function alertTypeSet(values: readonly string[]): Set<string> {
  return new Set(values);
}

function alertTypesFromPatch(patch: { dews?: boolean; depeg?: boolean; safety?: boolean }): Set<string> {
  const out = new Set<string>();
  if (patch.dews) out.add("dews");
  if (patch.depeg) out.add("depeg");
  if (patch.safety) out.add("safety");
  if (out.size === 0) throw new TelegramMiniAppMutationError("empty-alert-types");
  return out;
}

async function presetCoins(db: D1Database, presetId: TelegramPresetId): Promise<string[]> {
  const resolved = await resolveTelegramPresetTargets(db, [presetId]);
  if (resolved.kind !== "ok") throw new TelegramMiniAppMutationError("preset-unavailable", 503);
  const preset = resolved.presets.find((entry) => entry.definition.id === presetId);
  if (!preset) throw new TelegramMiniAppMutationError("unknown-preset");
  return preset.stablecoinIds;
}

async function setGlobal(db: D1Database, chatId: string, username: string | null, operation: Extract<TelegramMiniAppOperation, { kind: "set-global" }>): Promise<void> {
  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: unixNow(),
    globalAlertOverrides: { [operation.alertType]: operation.enabled ? 1 : 0 } as NonNullable<UpsertSubscriberInput["globalAlertOverrides"]>,
  });
}

async function setQuietHours(db: D1Database, chatId: string, username: string | null, operation: Extract<TelegramMiniAppOperation, { kind: "set-quiet-hours" }>): Promise<void> {
  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: unixNow(),
    quietHours: operation.enabled
      ? { enabled: true, startHourUtc: operation.startHourUtc ?? DEFAULT_QUIET_START_HOUR, endHourUtc: operation.endHourUtc ?? DEFAULT_QUIET_END_HOUR }
      : { enabled: false },
  });
}

async function setCoin(db: D1Database, chatId: string, username: string | null, operation: Extract<TelegramMiniAppOperation, { kind: "set-coin" }>): Promise<void> {
  assertCoin(operation.stablecoinId);
  const patch = operation.patch;
  let appliedCount = 0;

  const apply = async (setting: "db" | "ds" | "sm" | "lc", value: string): Promise<void> => {
    const result = await applyCoinSetting(db, chatId, username, operation.stablecoinId, setting, value);
    if (result == null) throw new TelegramMiniAppMutationError("invalid-coin-patch");
    appliedCount += 1;
  };

  if (patch.alertTypes) {
    const enabled = new Set<string>();
    for (const [alertType, on] of Object.entries(patch.alertTypes)) {
      if (on) {
        enabled.add(alertType);
      } else if (alertType === "dews") {
        await apply("db", "0");
      } else if (alertType === "depeg") {
        await apply("ds", "0");
      } else if (alertType === "safety") {
        await apply("sm", "0");
      } else if (alertType === "launch") {
        await apply("lc", "0");
      }
    }
    if (enabled.size > 0) {
      await upsertSubscriberAndSubscriptions(db, chatId, username, enabled, [operation.stablecoinId]);
      appliedCount += 1;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "dewsMinBand")) {
    await apply("db", patch.dewsMinBand == null ? "0" : DEWS_BAND_TO_CODE[patch.dewsMinBand]);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "depegStepBps")) {
    await apply("ds", patch.depegStepBps == null ? "0" : String(patch.depegStepBps));
  }
  if (Object.prototype.hasOwnProperty.call(patch, "safetyMode")) {
    await apply("sm", patch.safetyMode == null ? "0" : SAFETY_MODE_TO_CODE[patch.safetyMode]);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "launch")) {
    await apply("lc", patch.launch ? "1" : "0");
  }
  if (appliedCount === 0) throw new TelegramMiniAppMutationError("invalid-coin-patch");
}

export async function applyTelegramMiniAppMutation(db: D1Database, auth: TelegramMiniAppAuthContext, operation: TelegramMiniAppOperation): Promise<void> {
  const chatId = privateChatId(auth);
  const username = auth.username;
  switch (operation.kind) {
    case "recommended-setup": {
      const coins = await presetCoins(db, operation.presetId);
      const alertTypes = alertTypeSet(operation.alertTypes);
      await upsertSubscriberAndSubscriptions(db, chatId, username, alertTypes, coins);
      await upsertPresetSubscriptions(db, chatId, [operation.presetId], alertTypes);
      return;
    }
    case "set-global":
      await setGlobal(db, chatId, username, operation);
      return;
    case "set-quiet-hours":
      await setQuietHours(db, chatId, username, operation);
      return;
    case "clear-snooze":
      await clearSnoozeViaSettings(db, chatId, username);
      return;
    case "set-coin":
      await setCoin(db, chatId, username, operation);
      return;
    case "remove-coin":
      assertCoin(operation.stablecoinId);
      await removeSubscriptions(db, chatId, [operation.stablecoinId]);
      return;
    case "follow-preset": {
      const coins = await presetCoins(db, operation.presetId);
      const alertTypes = alertTypesFromPatch(operation.alertTypes);
      const options = operation.alertTypes.depeg && "depegStepBps" in operation ? { depegWorseningBpsStep: operation.depegStepBps ?? null } : undefined;
      await upsertSubscriberAndSubscriptions(db, chatId, username, alertTypes, coins, options);
      await upsertPresetSubscriptions(db, chatId, [operation.presetId], alertTypes, options);
      return;
    }
    case "unfollow-preset": {
      const coins = await presetCoins(db, operation.presetId);
      await removeSubscriptions(db, chatId, coins);
      await removePresetSubscriptions(db, chatId, [operation.presetId]);
      return;
    }
  }
}

export function mutationActionDetail(operation: TelegramMiniAppOperation): string {
  if (operation.kind === "set-global") return operation.alertType;
  if (operation.kind === "set-coin" || operation.kind === "remove-coin") return "coin";
  if (operation.kind === "recommended-setup" || operation.kind === "follow-preset" || operation.kind === "unfollow-preset") return "preset";
  if (operation.kind === "set-quiet-hours") return "quiet_hours";
  return operation.kind;
}
