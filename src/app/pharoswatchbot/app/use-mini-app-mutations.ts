"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { ALERT_LABELS, SNOOZE_DURATION_LABELS, presetLabel as presetCopyLabel, type PresetAlertType } from "./constants";
import { familyCoverage, formatQuietHoursRange } from "./format";
import {
  isAmbiguousMiniAppWriteError,
  miniAppErrorMessage,
  MiniAppRequestError,
} from "./error-messages";
import {
  isMiniAppVersionMismatch,
  postMiniAppBulkWatchlistPreview,
  postMiniAppSnapshot,
  refreshMiniAppBundleOnce,
  type TelegramMiniAppClientSnapshot,
} from "./mini-app-api";
import { canUseTelegramPopup, type TelegramWebAppSdk } from "./telegram-sdk";
import type {
  CoalescibleMutationOperation,
  FollowedPreset,
  SubscribedCoin,
  TelegramAlertType,
  TelegramDepegStepBps,
  TelegramDewsBand,
  TelegramMiniAppBulkWatchlistOperation,
  TelegramMiniAppBulkWatchlistResponse,
  TelegramMiniAppOperation,
  TelegramMiniAppState,
  TelegramSafetyMode,
} from "./types";

const MUTATE_ENDPOINT = API_PATHS.telegramMiniAppMutation();
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/** Grace period during which a removal or bulk edit can be undone from the snackbar. */
const UNDO_WINDOW_MS = 8_000;

type SignedReadOperation = Extract<TelegramMiniAppBulkWatchlistOperation, { kind: "preview-bulk-watchlist" }>;
type BulkSourceImpact = TelegramMiniAppBulkWatchlistResponse["result"]["sourceImpact"];
type SetCoinOperation = Extract<TelegramMiniAppOperation, { kind: "set-coin" }>;
type FollowPresetOperation = Extract<TelegramMiniAppOperation, { kind: "follow-preset" }>;
type CoinPatch = SetCoinOperation["patch"];
type UndoOperation = Extract<TelegramMiniAppOperation, { kind: "undo-bulk-watchlist" }>;

interface NormalizedCoinTarget {
  kind: "set-coin";
  stablecoinId: string;
  alertTypes: Partial<Record<TelegramAlertType, boolean>>;
  /** Tracks families explicitly toggled on/off (not merely implied by tuning). */
  explicitFlags: Partial<Record<TelegramAlertType, true>>;
  dewsMinBand?: TelegramDewsBand | null;
  depegStepBps?: TelegramDepegStepBps | null;
  safetyMode?: TelegramSafetyMode | null;
}

interface NormalizedPresetTarget {
  kind: "follow-preset";
  presetId: FollowPresetOperation["presetId"];
  alertTypes: Partial<Record<PresetAlertType, boolean>>;
  depegStepBps?: TelegramDepegStepBps | null;
}

type NormalizedQueuedTarget = NormalizedCoinTarget | NormalizedPresetTarget;

type MutationWaiter = (snapshot: TelegramMiniAppClientSnapshot | null) => void;

type LaneState =
  | { phase: "idle" }
  | {
      phase: "inflight";
      epoch: number;
      operation: TelegramMiniAppOperation;
      waiters: MutationWaiter[];
    }
  | {
      phase: "inflight+queued";
      epoch: number;
      operation: CoalescibleMutationOperation;
      waiters: MutationWaiter[];
      queued: NormalizedQueuedTarget;
      queuedWaiters: MutationWaiter[];
    };

function canCoalesce(
  inflight: TelegramMiniAppOperation,
  incoming: TelegramMiniAppOperation,
): incoming is CoalescibleMutationOperation {
  if (inflight.kind === "set-coin" && incoming.kind === "set-coin") {
    return inflight.stablecoinId === incoming.stablecoinId;
  }
  if (inflight.kind === "follow-preset" && incoming.kind === "follow-preset") {
    return inflight.presetId === incoming.presetId;
  }
  return false;
}

/**
 * Fold an incoming `set-coin` patch onto an existing normalized target.
 * - Normalizes reserve/freeze/launch top-level aliases into `alertTypes`
 *   (explicit `alertTypes[family] === false` wins over alias in the same patch).
 * - Preserves absent vs explicit `null` tuning.
 * - A tuning selection enables its family; explicit `false` wins over tuning
 *   in the same patch and clears that family's tuning to `null`.
 * - Turning a family off then back on preserves the cleared `null` tuning so an
 *   in-flight tuning write is never left silently active.
 */
function mergeCoinTarget(base: NormalizedCoinTarget | null, operation: SetCoinOperation): NormalizedCoinTarget {
  const next: NormalizedCoinTarget = base
    ? {
        kind: "set-coin",
        stablecoinId: base.stablecoinId,
        alertTypes: { ...base.alertTypes },
        explicitFlags: { ...base.explicitFlags },
        ...("dewsMinBand" in base ? { dewsMinBand: base.dewsMinBand } : {}),
        ...("depegStepBps" in base ? { depegStepBps: base.depegStepBps } : {}),
        ...("safetyMode" in base ? { safetyMode: base.safetyMode } : {}),
      }
    : {
        kind: "set-coin",
        stablecoinId: operation.stablecoinId,
        alertTypes: {},
        explicitFlags: {},
      };

  const patch = operation.patch;

  // DEWS
  const dewsFlag = patch.alertTypes?.dews;
  if (dewsFlag === false) {
    next.alertTypes.dews = false;
    next.explicitFlags.dews = true;
    next.dewsMinBand = null;
  } else if (patch.dewsMinBand !== undefined) {
    next.alertTypes.dews = true;
    if (dewsFlag === true) next.explicitFlags.dews = true;
    next.dewsMinBand = patch.dewsMinBand;
  } else if (dewsFlag === true) {
    next.alertTypes.dews = true;
    next.explicitFlags.dews = true;
  }

  // Depeg
  const depegFlag = patch.alertTypes?.depeg;
  if (depegFlag === false) {
    next.alertTypes.depeg = false;
    next.explicitFlags.depeg = true;
    next.depegStepBps = null;
  } else if (patch.depegStepBps !== undefined) {
    next.alertTypes.depeg = true;
    if (depegFlag === true) next.explicitFlags.depeg = true;
    next.depegStepBps = patch.depegStepBps;
  } else if (depegFlag === true) {
    next.alertTypes.depeg = true;
    next.explicitFlags.depeg = true;
  }

  // Safety
  const safetyFlag = patch.alertTypes?.safety;
  if (safetyFlag === false) {
    next.alertTypes.safety = false;
    next.explicitFlags.safety = true;
    next.safetyMode = null;
  } else if (patch.safetyMode !== undefined) {
    next.alertTypes.safety = true;
    if (safetyFlag === true) next.explicitFlags.safety = true;
    next.safetyMode = patch.safetyMode;
  } else if (safetyFlag === true) {
    next.alertTypes.safety = true;
    next.explicitFlags.safety = true;
  }

  // Plain families (normalize top-level aliases into alertTypes).
  for (const plainType of ["reserve", "freeze", "launch"] as const) {
    const flag = patch.alertTypes?.[plainType];
    const direct = patch[plainType];
    const finalEnabled = flag === false ? false : direct !== undefined ? direct : flag;
    if (finalEnabled !== undefined) {
      next.alertTypes[plainType] = finalEnabled;
      next.explicitFlags[plainType] = true;
    }
  }

  return next;
}

/**
 * Merge `follow-preset` fields strictly by field presence without ever
 * reconstructing untouched booleans from an older snapshot.
 */
function mergePresetTarget(base: NormalizedPresetTarget | null, operation: FollowPresetOperation): NormalizedPresetTarget {
  const next: NormalizedPresetTarget = base
    ? {
        kind: "follow-preset",
        presetId: base.presetId,
        alertTypes: { ...base.alertTypes },
        ...("depegStepBps" in base ? { depegStepBps: base.depegStepBps } : {}),
      }
    : {
        kind: "follow-preset",
        presetId: operation.presetId,
        alertTypes: {},
      };

  if (operation.alertTypes.dews !== undefined) {
    next.alertTypes.dews = operation.alertTypes.dews;
  }
  if (operation.alertTypes.safety !== undefined) {
    next.alertTypes.safety = operation.alertTypes.safety;
  }

  if (operation.alertTypes.depeg === false) {
    next.alertTypes.depeg = false;
    next.depegStepBps = null;
  } else {
    if (operation.alertTypes.depeg === true) {
      next.alertTypes.depeg = true;
    }
    if (operation.depegStepBps !== undefined) {
      next.depegStepBps = operation.depegStepBps;
      if (operation.depegStepBps !== null || next.alertTypes.depeg === false) {
        next.alertTypes.depeg = true;
      }
    }
  }

  return next;
}

function mergeCoalescibleTarget(
  base: NormalizedQueuedTarget | null,
  operation: CoalescibleMutationOperation,
): NormalizedQueuedTarget {
  if (operation.kind === "set-coin") {
    return mergeCoinTarget(base?.kind === "set-coin" ? base : null, operation);
  }
  return mergePresetTarget(base?.kind === "follow-preset" ? base : null, operation);
}

function toDisplayQueuedOperation(target: NormalizedQueuedTarget): CoalescibleMutationOperation {
  if (target.kind === "set-coin") {
    const patch: CoinPatch = {};
    if (Object.keys(target.alertTypes).length > 0) patch.alertTypes = { ...target.alertTypes };
    if ("dewsMinBand" in target && target.alertTypes.dews !== false) patch.dewsMinBand = target.dewsMinBand;
    if ("depegStepBps" in target && target.alertTypes.depeg !== false) patch.depegStepBps = target.depegStepBps;
    if ("safetyMode" in target && target.alertTypes.safety !== false) patch.safetyMode = target.safetyMode;
    return { kind: "set-coin", stablecoinId: target.stablecoinId, patch };
  }
  return {
    kind: "follow-preset",
    presetId: target.presetId,
    alertTypes: { ...target.alertTypes },
    ...("depegStepBps" in target && target.alertTypes.depeg !== false ? { depegStepBps: target.depegStepBps } : {}),
  };
}

function isCoinOverrideSatisfied(
  stablecoinId: string,
  coin: SubscribedCoin,
  family: TelegramAlertType,
  targetEnabled: boolean,
  snapshotState: TelegramMiniAppState,
): boolean {
  if (coin.alertOverrides !== undefined) {
    return coin.alertOverrides[family] === true;
  }
  if (targetEnabled) return true;
  return familyCoverage(
    stablecoinId,
    coin,
    family,
    snapshotState.subscriber.globalAlerts,
    snapshotState.presets,
  ).kind === "off";
}

function diffCoinTarget(target: NormalizedCoinTarget, snapshotState: TelegramMiniAppState): SetCoinOperation | null {
  const coin = snapshotState.subscriptions.find((entry) => entry.stablecoinId === target.stablecoinId) ?? null;
  const residualAlertTypes: Partial<Record<TelegramAlertType, boolean>> = {};
  const residualPatch: CoinPatch = {};

  const tunedFamilies = [
    ["dews", "dewsMinBand"],
    ["depeg", "depegStepBps"],
    ["safety", "safetyMode"],
  ] as const;

  for (const [family, tuningKey] of tunedFamilies) {
    const desiredFlag = target.alertTypes[family];
    const tuningTouched = tuningKey in target;
    if (desiredFlag === undefined && !tuningTouched) continue;

    if (desiredFlag === false) {
      const satisfied = coin != null
        && coin.alertTypes[family] === false
        && isCoinOverrideSatisfied(target.stablecoinId, coin, family, false, snapshotState)
        && coin[tuningKey] === null;
      if (!satisfied) {
        residualAlertTypes[family] = false;
      }
      continue;
    }

    const flagSatisfied = coin != null
      && coin.alertTypes[family] === true
      && isCoinOverrideSatisfied(target.stablecoinId, coin, family, true, snapshotState);
    const tuningSatisfied = !tuningTouched || (coin != null && coin[tuningKey] === target[tuningKey]);

    if (!flagSatisfied || !tuningSatisfied) {
      if (tuningTouched) {
        if (tuningKey === "dewsMinBand") residualPatch.dewsMinBand = target.dewsMinBand;
        else if (tuningKey === "depegStepBps") residualPatch.depegStepBps = target.depegStepBps;
        else residualPatch.safetyMode = target.safetyMode;
      }
      if (desiredFlag === true && (!flagSatisfied || target.explicitFlags[family])) {
        residualAlertTypes[family] = true;
      }
    }
  }

  for (const plainType of ["reserve", "freeze", "launch"] as const) {
    const desired = target.alertTypes[plainType];
    if (desired === undefined) continue;
    const satisfied = coin != null
      && coin.alertTypes[plainType] === desired
      && isCoinOverrideSatisfied(target.stablecoinId, coin, plainType, desired, snapshotState);
    if (!satisfied) {
      residualAlertTypes[plainType] = desired;
    }
  }

  if (Object.keys(residualAlertTypes).length > 0) {
    residualPatch.alertTypes = residualAlertTypes;
  }
  if (Object.keys(residualPatch).length === 0) return null;
  return { kind: "set-coin", stablecoinId: target.stablecoinId, patch: residualPatch };
}

function diffPresetTarget(target: NormalizedPresetTarget, snapshotState: TelegramMiniAppState): FollowPresetOperation | null {
  const followed = snapshotState.presets.find((preset) => preset.id === target.presetId) ?? null;
  const residualAlertTypes: Partial<Record<PresetAlertType, boolean>> = {};
  let residualStep: TelegramDepegStepBps | null | undefined;
  let includeStep = false;

  for (const family of ["dews", "depeg", "safety"] as const) {
    const desired = target.alertTypes[family];
    if (desired === undefined) continue;
    if (!followed || followed.alertTypes[family] !== desired) {
      residualAlertTypes[family] = desired;
    }
  }

  if ("depegStepBps" in target) {
    if (target.alertTypes.depeg === false) {
      if (!followed || followed.alertTypes.depeg !== false || followed.depegStepBps !== null) {
        residualAlertTypes.depeg = false;
        residualStep = null;
        includeStep = true;
      }
    } else if (!followed || followed.depegStepBps !== target.depegStepBps) {
      residualStep = target.depegStepBps;
      includeStep = true;
      if (target.alertTypes.depeg === true && residualAlertTypes.depeg === undefined) {
        residualAlertTypes.depeg = true;
      }
    }
  }

  if (Object.keys(residualAlertTypes).length === 0 && !includeStep) return null;
  return {
    kind: "follow-preset",
    presetId: target.presetId,
    alertTypes: residualAlertTypes,
    ...(includeStep ? { depegStepBps: residualStep } : {}),
  };
}

function diffQueuedTarget(
  target: NormalizedQueuedTarget,
  snapshotState: TelegramMiniAppState,
): CoalescibleMutationOperation | null {
  return target.kind === "set-coin"
    ? diffCoinTarget(target, snapshotState)
    : diffPresetTarget(target, snapshotState);
}

function coinSymbol(state: TelegramMiniAppState | null, stablecoinId: string): string {
  return state?.subscriptions.find((c) => c.stablecoinId === stablecoinId)?.symbol
    ?? state?.catalog.searchableCoins.find((c) => c.stablecoinId === stablecoinId)?.symbol
    ?? "Coin";
}

function presetLabel(state: TelegramMiniAppState | null, presetId: string): string {
  return presetCopyLabel(presetId, state?.presets.find((preset) => preset.id === presetId)?.label
    ?? state?.catalog.recommendedPresets.find((preset) => preset.id === presetId)?.label
    ?? "Preset");
}

function countCoins(count: number): string {
  return `${count} ${count === 1 ? "coin" : "coins"}`;
}

interface AppliedBulkSummary {
  added: number;
  removed: number;
  sourceImpact?: BulkSourceImpact;
}

interface DispatchMutationOptions {
  appliedBulk?: AppliedBulkSummary;
  successMessage?: string;
  undo?: UndoOperation;
  /** Derive undo from the server response snapshot (used by `remove-coin`). */
  useResponseUndo?: boolean;
}

function formatRemovalSourceImpact(
  state: TelegramMiniAppState | null,
  sourceImpact: BulkSourceImpact | undefined,
): string {
  if (!sourceImpact || sourceImpact.length === 0) return "";
  const stillCovered = sourceImpact.filter(
    (entry) => entry.action === "remove" && entry.inheritedSourcesAfter.length > 0,
  );
  if (stillCovered.length === 0) return "";
  if (stillCovered.length === 1) {
    const entry = stillCovered[0]!;
    const hasPreset = entry.inheritedSourcesAfter.includes("preset");
    const hasGlobal = entry.inheritedSourcesAfter.includes("global");
    const sourceText = hasPreset && hasGlobal
      ? "a preset and All stablecoins"
      : hasPreset
        ? "a preset"
        : "All stablecoins";
    return ` ${coinSymbol(state, entry.stablecoinId)} is still covered by ${sourceText}.`;
  }
  return ` ${stillCovered.length} still covered by presets or All stablecoins.`;
}

/** User-facing confirmation for a saved change; also the stale-auth "Not saved" intent. */
function mutationSuccessAnnouncement(
  operation: TelegramMiniAppOperation,
  state: TelegramMiniAppState | null,
  appliedBulk?: AppliedBulkSummary,
): string {
  switch (operation.kind) {
    case "preview-bulk-watchlist":
    case "confirm-bulk-watchlist":
    case "apply-bulk-watchlist": {
      // The server may classify part of the selection as already matching; report
      // the actual applied adds/removes and any remaining inherited coverage.
      const added = appliedBulk?.added ?? operation.addStablecoinIds.length;
      const removed = appliedBulk?.removed ?? operation.removeStablecoinIds.length;
      const impactSuffix = formatRemovalSourceImpact(state, appliedBulk?.sourceImpact);
      if (removed === 0) return `Added ${countCoins(added)}.`;
      if (added === 0) return `Removed ${countCoins(removed)}.${impactSuffix}`;
      return `Added ${countCoins(added)}, removed ${removed}.${impactSuffix}`;
    }
    case "undo-bulk-watchlist":
      return "Change undone.";
    case "recommended-setup":
      return "Following USD Top 25: early warnings and depegs.";
    case "set-global":
      return `All stablecoins: ${ALERT_LABELS[operation.alertType]} ${operation.enabled ? "on" : "off"}.`;
    case "set-global-depeg-step":
      return "All stablecoins: depeg alerts updated.";
    case "set-quiet-hours":
      return operation.enabled
        ? operation.startHourUtc != null && operation.endHourUtc != null
          ? `Quiet hours ${formatQuietHoursRange(operation.startHourUtc, operation.endHourUtc)}.`
          : "Quiet hours on."
        : "Quiet hours off.";
    case "clear-snooze":
      return "Alerts resumed.";
    case "set-coin": {
      const symbol = coinSymbol(state, operation.stablecoinId);
      const changed = Object.entries(operation.patch.alertTypes ?? {});
      if (changed.length === 1 && Object.keys(operation.patch).length === 1) {
        const [type, enabled] = changed[0] as [keyof typeof ALERT_LABELS, boolean];
        return `${symbol}: ${ALERT_LABELS[type]} ${enabled ? "on" : "off"}.`;
      }
      if ("depegStepBps" in operation.patch && Object.keys(operation.patch).length === 1) {
        return `${symbol}: depeg alerts updated.`;
      }
      return `${symbol} updated.`;
    }
    case "remove-coin":
      return `${coinSymbol(state, operation.stablecoinId)} removed.`;
    case "set-snooze":
      return `Paused for ${SNOOZE_DURATION_LABELS[operation.durationToken]}.`;
    case "pause":
      return "Alerts paused until you resume.";
    case "set-coin-snooze": {
      const symbol = coinSymbol(state, operation.stablecoinId);
      return operation.durationToken === "clear"
        ? `${symbol} snooze cleared.`
        : `${symbol} snoozed for ${SNOOZE_DURATION_LABELS[operation.durationToken]}.`;
    }
    case "set-timezone":
      return operation.timezone == null ? "Time zone cleared." : `Time zone set to ${operation.timezone}.`;
    case "unsubscribe-all":
      return "Unsubscribed from all alerts.";
    case "forget-me":
      return "All your data has been deleted.";
    case "follow-preset":
      return state?.presets.some((preset) => preset.id === operation.presetId)
        ? `${presetLabel(state, operation.presetId)} updated.`
        : `Following ${presetLabel(state, operation.presetId)}.`;
    case "unfollow-preset":
      return `Unfollowed ${presetLabel(state, operation.presetId)}.`;
  }
}

function isStaleAuthError(err: unknown): boolean {
  return err instanceof MiniAppRequestError && err.status === 401 && err.code === "stale-auth";
}

function staleAuthIntent(operation: TelegramMiniAppOperation, state: TelegramMiniAppState | null): string {
  if (operation.kind === "forget-me") return "Data deletion was not run.";
  return `Not saved: ${mutationSuccessAnnouncement(operation, state)}`;
}

function confirmThenFire(
  confirmFn: TelegramWebAppSdk["showConfirm"] | undefined,
  message: string,
  fire: () => void,
  cancel?: () => void,
) {
  if (!confirmFn) {
    fire();
    return;
  }
  confirmFn(message, (confirmed) => {
    if (confirmed) fire();
    else cancel?.();
  });
}

export interface UseMiniAppMutationsArgs {
  /** Signed Telegram launch payload. The hook is a no-op until this is non-empty. */
  initData: string;
  /** Latest server snapshot, or `null` before the first successful session load. */
  state: TelegramMiniAppState | null;
  /** Opaque revision of the currently displayed snapshot (used to clear stale Undo proof). */
  stateRevision?: string | null;
  /** Telegram WebApp handle (for haptics, dialogs, requestWriteAccess, checkHomeScreenStatus). */
  webApp: TelegramWebAppSdk | null;
  /** Replace the confirmed server snapshot after a successful non-`forget-me` mutation. */
  onSnapshotReplaced: (next: TelegramMiniAppClientSnapshot) => void;
  /** Revoke the session and clear retained data after confirmed deletion. */
  onForgotten: () => void;
  /**
   * Telegram launch auth is known to be expired. Telegram never refreshes
   * `initData` inside a running Mini App, so edits are kept as visible intent
   * and never sent; only a fresh launch can save them.
   */
  authExpired: boolean;
  /** False while session state is refreshing, stale, or otherwise read-only. */
  mutationsAllowed: boolean;
  /** Signed private-session reads remain available through Telegram's 24h window. */
  signedReadsAllowed: boolean;
  /** A signed read hit `stale-auth`: the 24h session window is over and no signed request can succeed. */
  onSessionAuthExpired: () => void;
  /** Trigger a read-only session refresh (used after `409 stale-bulk-preview` drift, never replays writes). */
  onRefreshSession?: () => void;
  /** Enter terminal update-required state when a `409` version mismatch already ran its one-shot reload. */
  onUpdateRequired?: () => void;
  /** Advance the shell's monotonic snapshot epoch when a write is dispatched so older reads cannot clobber it. */
  onWriteDispatched?: () => void;
}

/** One snackbar message. Errors persist until dismissed; success hides itself. */
export interface MiniAppNotice {
  id: number;
  tone: "success" | "error";
  text: string;
  /** Present while an undo for this change is still valid. */
  undoLabel?: string;
  /** Present on ambiguous write failures so the user can refresh server truth inline. */
  refreshAction?: boolean;
}

export interface MiniAppStaleAuthState {
  /** Monotonic ID so repeating an unsaved edit on the same control re-shows the snackbar. */
  id: number;
  intent: string | null;
}

export interface UseMiniAppMutationsResult {
  /** True between dispatch and either resolve or reject of the mutation lane. */
  isMutating: boolean;
  /** Mutation currently in flight, used for scoped control feedback. */
  pendingOperation: TelegramMiniAppOperation | null;
  /** Coalesced follow-up patch queued behind an in-flight `set-coin` or `follow-preset`. */
  queuedOperation: CoalescibleMutationOperation | null;
  /** Remaining server-directed edit lockout after a bounded-burst 429. */
  mutationRetryAfterSec: number;
  /** Latest success, error or undo message for the bottom snackbar. */
  notice: MiniAppNotice | null;
  /** Aria-live announcement for state changes that are not snackbar messages. */
  announcement: string;
  /** True once `forget-me` has resolved successfully — caller should switch to terminal view. */
  forgottenView: boolean;
  /** True once a 409 version mismatch persists after the one-shot reload already ran. */
  updateRequired: boolean;
  /** Returned status when `checkHomeScreenStatus` probe ran. Null until then. */
  homeScreenStatus: string | null;
  /**
   * Non-null once a request was rejected with `stale-auth` or an edit was
   * attempted while `authExpired`; `intent` describes the unsaved edit.
   */
  staleAuth: MiniAppStaleAuthState | null;

  /** Synchronous intended boolean lookup for rapid coin switch taps (reads in-flight + queued refs). */
  getIntendedCoinValue: (coinId: string, family: TelegramAlertType, confirmedValue: boolean) => boolean;
  /** Synchronous intended boolean lookup for rapid preset switch taps (reads in-flight + queued refs). */
  getIntendedPresetValue: (presetId: FollowPresetOperation["presetId"], family: PresetAlertType, confirmedValue: boolean) => boolean;

  /** Dispatch a mutation without changing visible values before server confirmation. */
  mutate: (operation: TelegramMiniAppOperation) => void;
  /** Imperative dispatch returning the confirmed server snapshot on success. */
  performMutation: (operation: TelegramMiniAppOperation) => Promise<TelegramMiniAppClientSnapshot | null>;
  /** Signed read-only bulk preview request. Does not consume edit burst capacity. */
  performBulkWatchlistPreview: (operation: Extract<TelegramMiniAppBulkWatchlistOperation, { kind: "preview-bulk-watchlist" }>) => Promise<TelegramMiniAppBulkWatchlistResponse | null>;
  /** Preview then confirm a multi-coin add/remove; arms an undo in the snackbar. Resolves true on success. */
  applyBulkWatchlist: (addStablecoinIds: string[], removeStablecoinIds: string[]) => Promise<boolean>;
  /** Confirm-then-remove (or reset to preset/global) one coin; arms an undo in the snackbar. Resolves true on success. */
  remove: (coin: SubscribedCoin, coveredBySource?: string | null) => Promise<boolean>;
  /** Run the snackbar undo. No-op once the window has expired or while busy. */
  undo: () => void;
  /** Hide the current snackbar message. */
  dismissNotice: () => void;
  /** Show a client-side validation message in the snackbar. */
  showError: (text: string) => void;

  /** Imperative hook for the "add to home screen" row. */
  addToHomeScreen: () => void;

  /** Confirm-then-unfollow flow for a followed group. Resolves true on success. */
  unfollowPreset: (preset: FollowedPreset) => Promise<boolean>;
  /** Indefinite pause ("until I resume"), dispatched directly from explicit user choice. */
  pause: () => void;
  /** Confirm-then-unsubscribe-all flow for the Settings data section. */
  unsubscribeAll: () => void;
  /** Native destructive popup (or fallback confirm) forget-me flow for the Settings data section. */
  forgetMe: () => void;
}

/**
 * Server-confirmed mutation coordinator (`idle` → `inflight` → `inflight+queued`)
 * with coalescing for `set-coin` (same coin) and `follow-preset` (same preset),
 * strict R2 server-confirmed UI truth, epoch invalidation, undo, and error resilience.
 */
export function useMiniAppMutations(args: UseMiniAppMutationsArgs): UseMiniAppMutationsResult {
  const {
    initData,
    state,
    stateRevision,
    webApp,
    onSnapshotReplaced,
    onForgotten,
    authExpired,
    mutationsAllowed,
    signedReadsAllowed,
    onSessionAuthExpired,
    onRefreshSession,
    onUpdateRequired,
    onWriteDispatched,
  } = args;

  const showConfirm = webApp?.showConfirm;
  const [isMutating, setIsMutating] = useState(false);
  const [notice, setNotice] = useState<MiniAppNotice | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [homeScreenStatus, setHomeScreenStatus] = useState<string | null>(null);
  const [forgottenView, setForgottenView] = useState(false);
  const [updateRequired, setUpdateRequired] = useState(false);
  const [pendingOperation, setPendingOperation] = useState<TelegramMiniAppOperation | null>(null);
  const [queuedOperation, setQueuedOperation] = useState<CoalescibleMutationOperation | null>(null);
  const [mutationRetryAfterSec, setMutationRetryAfterSec] = useState(0);
  const [staleAuth, setStaleAuth] = useState<MiniAppStaleAuthState | null>(null);

  const undoOperationRef = useRef<UndoOperation | null>(null);
  const undoRevisionRef = useRef<string | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeIdRef = useRef(0);
  const staleAuthIdRef = useRef(0);
  const hasRequestedWriteAccessRef = useRef(false);
  const hasMutatedThisSessionRef = useRef(false);
  const hasProbedHomeScreenRef = useRef(false);
  const mutationLimitWasActiveRef = useRef(false);
  const terminalRef = useRef(false);
  const launchEpochRef = useRef(0);
  const laneRef = useRef<LaneState>({ phase: "idle" });

  // Live refs so the async coalescing drain loop always checks fresh shell state.
  const initDataRef = useRef(initData);
  const stateRef = useRef(state);
  const stateRevisionRef = useRef(stateRevision ?? null);
  const prevStateRevisionRef = useRef(stateRevision ?? null);
  const webAppRef = useRef(webApp);
  const authExpiredRef = useRef(authExpired);
  const mutationsAllowedRef = useRef(mutationsAllowed);
  const signedReadsAllowedRef = useRef(signedReadsAllowed);
  const staleAuthRef = useRef(staleAuth);
  const mutationRetryAfterSecRef = useRef(mutationRetryAfterSec);
  const onSnapshotReplacedRef = useRef(onSnapshotReplaced);
  const onForgottenRef = useRef(onForgotten);
  const onSessionAuthExpiredRef = useRef(onSessionAuthExpired);
  const onRefreshSessionRef = useRef(onRefreshSession);
  const onUpdateRequiredRef = useRef(onUpdateRequired);
  const onWriteDispatchedRef = useRef(onWriteDispatched);
  const lastInitDataRef = useRef(initData);
  const lastViewerUserIdRef = useRef<string | null>(state?.viewer.userId ?? null);

  useIsomorphicLayoutEffect(() => {
    initDataRef.current = initData;
    stateRef.current = state;
    stateRevisionRef.current = stateRevision ?? null;
    webAppRef.current = webApp;
    authExpiredRef.current = authExpired;
    mutationsAllowedRef.current = mutationsAllowed;
    signedReadsAllowedRef.current = signedReadsAllowed;
    staleAuthRef.current = staleAuth;
    mutationRetryAfterSecRef.current = mutationRetryAfterSec;
    onSnapshotReplacedRef.current = onSnapshotReplaced;
    onForgottenRef.current = onForgotten;
    onSessionAuthExpiredRef.current = onSessionAuthExpired;
    onRefreshSessionRef.current = onRefreshSession;
    onUpdateRequiredRef.current = onUpdateRequired;
    onWriteDispatchedRef.current = onWriteDispatched;
  });

  const clearUndo = useCallback(() => {
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    undoOperationRef.current = null;
    undoRevisionRef.current = null;
    setNotice((current) => (current?.undoLabel ? { ...current, undoLabel: undefined } : current));
  }, []);

  const showNotice = useCallback((
    tone: MiniAppNotice["tone"],
    text: string,
    options?: { undo?: UndoOperation; undoRevision?: string; refreshAction?: boolean },
  ) => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = null;
    const undo = options?.undo ?? null;
    undoOperationRef.current = undo;
    undoRevisionRef.current = undo ? (options?.undoRevision ?? null) : null;
    noticeIdRef.current += 1;
    setNotice({
      id: noticeIdRef.current,
      tone,
      text,
      ...(undo ? { undoLabel: "Undo" } : {}),
      ...(options?.refreshAction ? { refreshAction: true } : {}),
    });
    if (undo) {
      undoTimerRef.current = setTimeout(() => {
        undoTimerRef.current = null;
        undoOperationRef.current = null;
        undoRevisionRef.current = null;
        setNotice((current) => (current?.undoLabel ? { ...current, undoLabel: undefined } : current));
      }, UNDO_WINDOW_MS);
    }
  }, []);

  const dismissNotice = useCallback(() => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = null;
    undoOperationRef.current = null;
    undoRevisionRef.current = null;
    setNotice(null);
  }, []);

  const showError = useCallback((text: string) => {
    showNotice("error", text);
    webApp?.HapticFeedback?.notificationOccurred?.("error");
  }, [showNotice, webApp]);

  const discardQueueOnly = useCallback(() => {
    const lane = laneRef.current;
    if (lane.phase !== "inflight+queued") return;
    const droppedWaiters = lane.queuedWaiters;
    laneRef.current = {
      phase: "inflight",
      epoch: lane.epoch,
      operation: lane.operation,
      waiters: lane.waiters,
    };
    setQueuedOperation(null);
    for (const resolve of droppedWaiters) resolve(null);
  }, []);

  const invalidateLaunchEpoch = useCallback(() => {
    launchEpochRef.current += 1;
    const lane = laneRef.current;
    laneRef.current = { phase: "idle" };
    if (lane.phase !== "idle") {
      setIsMutating(false);
      setPendingOperation(null);
      setQueuedOperation(null);
      for (const resolve of lane.waiters) resolve(null);
      if (lane.phase === "inflight+queued") {
        for (const resolve of lane.queuedWaiters) resolve(null);
      }
    }
  }, []);

  // Invalidate in-flight & queued mutations when launch initData or viewer account changes.
  useEffect(() => {
    const prevInit = lastInitDataRef.current;
    const prevUserId = lastViewerUserIdRef.current;
    const nextUserId = state?.viewer.userId ?? null;
    const initChanged = Boolean(prevInit && initData !== prevInit);
    const userChanged = Boolean(prevUserId && nextUserId && nextUserId !== prevUserId);
    lastInitDataRef.current = initData;
    if (nextUserId) lastViewerUserIdRef.current = nextUserId;
    if (initChanged || userChanged) {
      invalidateLaunchEpoch();
      clearUndo();
    }
  }, [clearUndo, initData, invalidateLaunchEpoch, state?.viewer.userId]);

  // Discard any queued patch immediately if auth expires or mutations become disallowed (e.g. stale session).
  useEffect(() => {
    if (authExpired || !mutationsAllowed) {
      discardQueueOnly();
    }
  }, [authExpired, discardQueueOnly, mutationsAllowed]);

  // Clear armed Undo once idle if an external refresh changed the snapshot revision.
  useEffect(() => {
    const prev = prevStateRevisionRef.current;
    const next = stateRevision ?? null;
    prevStateRevisionRef.current = next;
    if (
      !isMutating
      && prev !== next
      && undoOperationRef.current
      && undoRevisionRef.current != null
      && next != null
      && next !== undoRevisionRef.current
    ) {
      clearUndo();
    }
  }, [clearUndo, isMutating, stateRevision]);

  useEffect(() => {
    if (mutationRetryAfterSec <= 0) {
      if (mutationLimitWasActiveRef.current) {
        mutationLimitWasActiveRef.current = false;
        setAnnouncement("Pharos editing is available again.");
      }
      return;
    }
    mutationLimitWasActiveRef.current = true;
    const timer = setTimeout(() => {
      setMutationRetryAfterSec((current) => Math.max(0, current - 1));
    }, 1_000);
    return () => clearTimeout(timer);
  }, [mutationRetryAfterSec]);

  const getIntendedCoinValue = useCallback((
    coinId: string,
    family: TelegramAlertType,
    confirmedValue: boolean,
  ): boolean => {
    const lane = laneRef.current;
    if (lane.phase === "idle") return confirmedValue;
    if (lane.phase === "inflight+queued" && lane.queued.kind === "set-coin" && lane.queued.stablecoinId === coinId) {
      const queuedFlag = lane.queued.alertTypes[family];
      if (queuedFlag !== undefined) return queuedFlag;
    }
    if (lane.operation.kind === "set-coin" && lane.operation.stablecoinId === coinId) {
      const inflightTarget = mergeCoinTarget(null, lane.operation);
      const inflightFlag = inflightTarget.alertTypes[family];
      if (inflightFlag !== undefined) return inflightFlag;
    }
    return confirmedValue;
  }, []);

  const getIntendedPresetValue = useCallback((
    presetId: FollowPresetOperation["presetId"],
    family: PresetAlertType,
    confirmedValue: boolean,
  ): boolean => {
    const lane = laneRef.current;
    if (lane.phase === "idle") return confirmedValue;
    if (lane.phase === "inflight+queued" && lane.queued.kind === "follow-preset" && lane.queued.presetId === presetId) {
      const queuedFlag = lane.queued.alertTypes[family];
      if (queuedFlag !== undefined) return queuedFlag;
    }
    if (lane.operation.kind === "follow-preset" && lane.operation.presetId === presetId) {
      const inflightTarget = mergePresetTarget(null, lane.operation);
      const inflightFlag = inflightTarget.alertTypes[family];
      if (inflightFlag !== undefined) return inflightFlag;
    }
    return confirmedValue;
  }, []);

  const recordStaleAuthIntent = useCallback((operation: TelegramMiniAppOperation) => {
    staleAuthIdRef.current += 1;
    const next: MiniAppStaleAuthState = {
      id: staleAuthIdRef.current,
      intent: staleAuthIntent(operation, stateRef.current),
    };
    staleAuthRef.current = next;
    setStaleAuth(next);
  }, []);

  const readLane = (): LaneState => laneRef.current;

  const runMutationLane = useCallback(async (
    epoch: number,
    capturedInitData: string,
    initialOptions?: DispatchMutationOptions,
  ): Promise<void> => {
    let currentOptions = initialOptions;

    while (true) {
      const activeLane = readLane();
      if (activeLane.phase === "idle" || activeLane.epoch !== epoch) return;
      const currentOp = activeLane.operation;
      const preState = stateRef.current;
      const preViewerUserId = preState?.viewer.userId ?? null;
      const preSubscriberExists = preState?.subscriber.exists ?? false;
      const preChatType = preState?.viewer.chatType ?? null;

      try {
        const next = await postMiniAppSnapshot(MUTATE_ENDPOINT, {
          initData: capturedInitData,
          operation: currentOp,
        });

        // An invalidated launch epoch or terminal state must never install a late
        // response, fire success side effects, or drain queued work.
        if (terminalRef.current || launchEpochRef.current !== epoch) {
          return;
        }

        const currentLane = readLane();
        if (currentLane.phase === "idle" || currentLane.epoch !== epoch) {
          return;
        }

        if (currentOp.kind === "forget-me") {
          terminalRef.current = true;
          launchEpochRef.current += 1;
          const completedWaiters = currentLane.waiters;
          const droppedWaiters = currentLane.phase === "inflight+queued" ? currentLane.queuedWaiters : [];
          laneRef.current = { phase: "idle" };
          setIsMutating(false);
          setPendingOperation(null);
          setQueuedOperation(null);
          dismissNotice();
          onForgottenRef.current();
          setForgottenView(true);
          setAnnouncement(mutationSuccessAnnouncement(currentOp, next.state));
          webAppRef.current?.HapticFeedback?.notificationOccurred?.("success");
          for (const resolve of completedWaiters) resolve(next);
          for (const resolve of droppedWaiters) resolve(null);
          return;
        }

        // Install the confirmed snapshot once immediately.
        stateRef.current = next.state;
        onSnapshotReplacedRef.current(next);

        const activeWebApp = webAppRef.current;
        // T-57: requestWriteAccess once, after the first successful recommended-setup
        // for sender-launched users who had no subscriber row before.
        if (
          currentOp.kind === "recommended-setup"
          && !hasRequestedWriteAccessRef.current
          && !preSubscriberExists
          && preChatType === "sender"
          && activeWebApp?.isVersionAtLeast?.("6.9")
          && typeof activeWebApp.requestWriteAccess === "function"
        ) {
          hasRequestedWriteAccessRef.current = true;
          activeWebApp.requestWriteAccess();
        }
        // T-58: probe home-screen status once after the first successful mutation.
        if (!hasMutatedThisSessionRef.current) {
          hasMutatedThisSessionRef.current = true;
          if (
            !hasProbedHomeScreenRef.current
            && activeWebApp?.isVersionAtLeast?.("8.0")
            && typeof activeWebApp.checkHomeScreenStatus === "function"
          ) {
            hasProbedHomeScreenRef.current = true;
            activeWebApp.checkHomeScreenStatus((nextStatus) => {
              setHomeScreenStatus(nextStatus);
            });
          }
        }

        const completedWaiters = currentLane.waiters;
        const accountChanged = preViewerUserId != null && next.state.viewer.userId !== preViewerUserId;

        if (currentLane.phase === "inflight+queued") {
          const queuedTarget = currentLane.queued;
          const queuedWaiters = currentLane.queuedWaiters;

          if (accountChanged) {
            laneRef.current = { phase: "idle" };
            setIsMutating(false);
            setPendingOperation(null);
            setQueuedOperation(null);
            clearUndo();
            for (const resolve of completedWaiters) resolve(next);
            for (const resolve of queuedWaiters) resolve(null);
            return;
          }

          const residual = diffQueuedTarget(queuedTarget, next.state);
          if (residual == null) {
            // Returned server snapshot already satisfies every queued target field.
            laneRef.current = { phase: "idle" };
            setIsMutating(false);
            setPendingOperation(null);
            setQueuedOperation(null);
            showNotice("success", mutationSuccessAnnouncement(currentOp, preState ?? next.state, currentOptions?.appliedBulk));
            const haptics = activeWebApp?.HapticFeedback;
            if (currentOp.kind === "set-coin") haptics?.notificationOccurred?.("success");
            else haptics?.impactOccurred?.("light");
            for (const resolve of completedWaiters) resolve(next);
            for (const resolve of queuedWaiters) resolve(next);
            return;
          }

          const canDispatchResidual = !terminalRef.current
            && launchEpochRef.current === epoch
            && initDataRef.current === capturedInitData
            && !authExpiredRef.current
            && staleAuthRef.current == null
            && mutationsAllowedRef.current
            && next.state.viewer.canMutate === true
            && mutationRetryAfterSecRef.current === 0;

          if (!canDispatchResidual) {
            laneRef.current = { phase: "idle" };
            setIsMutating(false);
            setPendingOperation(null);
            setQueuedOperation(null);
            showNotice("success", mutationSuccessAnnouncement(currentOp, preState ?? next.state, currentOptions?.appliedBulk));
            for (const resolve of completedWaiters) resolve(next);
            for (const resolve of queuedWaiters) resolve(null);
            return;
          }

          // Dispatch exactly 1 residual compound patch; keep `isMutating` true continuously.
          laneRef.current = {
            phase: "inflight",
            epoch,
            operation: residual,
            waiters: queuedWaiters,
          };
          currentOptions = undefined;
          onWriteDispatchedRef.current?.();
          setPendingOperation(residual);
          setQueuedOperation(null);
          for (const resolve of completedWaiters) resolve(next);
          continue;
        }

        // Lane drained cleanly with no queued patch.
        laneRef.current = { phase: "idle" };
        setIsMutating(false);
        setPendingOperation(null);
        setQueuedOperation(null);
        const undoOp = currentOptions?.undo
          ?? (currentOptions?.useResponseUndo && next.undo
            ? { kind: "undo-bulk-watchlist" as const, ...next.undo }
            : undefined);
        const appliedBulkSummary: AppliedBulkSummary | undefined = currentOptions?.appliedBulk
          ?? (next.bulkResult
            ? {
                added: next.bulkResult.adds.length,
                removed: next.bulkResult.removes.length,
                sourceImpact: next.bulkResult.sourceImpact,
              }
            : undefined);
        const noticeText = currentOptions?.successMessage
          ?? mutationSuccessAnnouncement(currentOp, preState ?? next.state, appliedBulkSummary);
        showNotice("success", noticeText, {
          undo: undoOp,
          undoRevision: undoOp ? next.stateRevision : undefined,
        });
        const haptics = activeWebApp?.HapticFeedback;
        if (
          currentOp.kind === "recommended-setup"
          || currentOp.kind === "set-coin"
          || currentOp.kind === "remove-coin"
          || currentOp.kind === "confirm-bulk-watchlist"
          || currentOp.kind === "apply-bulk-watchlist"
        ) {
          haptics?.notificationOccurred?.("success");
        } else {
          haptics?.impactOccurred?.("light");
        }
        for (const resolve of completedWaiters) resolve(next);
        return;
      } catch (err) {
        if (terminalRef.current || launchEpochRef.current !== epoch) {
          return;
        }
        const currentLane = laneRef.current;
        const allWaiters: MutationWaiter[] = currentLane.phase === "idle"
          ? []
          : currentLane.phase === "inflight+queued"
            ? [...currentLane.waiters, ...currentLane.queuedWaiters]
            : [...currentLane.waiters];

        // Discard any queued patch immediately on ANY error (zero auto-replay).
        laneRef.current = { phase: "idle" };
        setIsMutating(false);
        setPendingOperation(null);
        setQueuedOperation(null);

        let shouldAutoRefresh = false;
        if (isMiniAppVersionMismatch(err)) {
          const reloaded = refreshMiniAppBundleOnce({
            contractVersion: err.serverContractVersion,
            catalogVersion: err.serverCatalogVersion,
          });
          if (!reloaded) {
            terminalRef.current = true;
            setUpdateRequired(true);
            onUpdateRequiredRef.current?.();
          }
          for (const resolve of allWaiters) resolve(null);
          return;
        }

        if (err instanceof MiniAppRequestError && err.status === 429 && err.code === "rate-limited") {
          const retryAfterSec = err.retryAfterSec ?? 1;
          setMutationRetryAfterSec((current) => Math.max(current, retryAfterSec));
          setAnnouncement(`Pharos edit limit reached. Settings are disabled for ${retryAfterSec} ${retryAfterSec === 1 ? "second" : "seconds"}.`);
        } else if (isStaleAuthError(err)) {
          recordStaleAuthIntent(currentOp);
        } else if (err instanceof MiniAppRequestError && err.code === "stale-bulk-preview") {
          showNotice("error", miniAppErrorMessage(err, "mutation"));
          shouldAutoRefresh = true;
        } else {
          showNotice("error", miniAppErrorMessage(err, "mutation"), {
            refreshAction: isAmbiguousMiniAppWriteError(err),
          });
        }
        webAppRef.current?.HapticFeedback?.notificationOccurred?.("error");
        for (const resolve of allWaiters) resolve(null);
        if (shouldAutoRefresh) {
          onRefreshSessionRef.current?.();
        }
        return;
      }
    }
  }, [clearUndo, dismissNotice, recordStaleAuthIntent, showNotice]);

  const dispatchMutation = useCallback((
    operation: TelegramMiniAppOperation,
    options?: DispatchMutationOptions,
  ): Promise<TelegramMiniAppClientSnapshot | null> => {
    if (terminalRef.current) return Promise.resolve(null);
    if (authExpiredRef.current || staleAuthRef.current) {
      // Resending frozen initData is guaranteed to fail; keep visible intent in the snackbar.
      recordStaleAuthIntent(operation);
      webAppRef.current?.HapticFeedback?.notificationOccurred?.("warning");
      return Promise.resolve(null);
    }
    if (
      !initDataRef.current
      || !mutationsAllowedRef.current
      || stateRef.current?.viewer.canMutate !== true
      || mutationRetryAfterSecRef.current > 0
    ) {
      return Promise.resolve(null);
    }

    const currentLane = laneRef.current;
    if (currentLane.phase !== "idle") {
      if (canCoalesce(currentLane.operation, operation)) {
        const waiter = Promise.withResolvers<TelegramMiniAppClientSnapshot | null>();
        const mergedTarget = mergeCoalescibleTarget(
          currentLane.phase === "inflight+queued" ? currentLane.queued : null,
          operation,
        );
        if (currentLane.phase === "inflight") {
          laneRef.current = {
            phase: "inflight+queued",
            epoch: currentLane.epoch,
            operation: currentLane.operation as CoalescibleMutationOperation,
            waiters: currentLane.waiters,
            queued: mergedTarget,
            queuedWaiters: [waiter.resolve],
          };
        } else {
          currentLane.queued = mergedTarget;
          currentLane.queuedWaiters.push(waiter.resolve);
        }
        setQueuedOperation(toDisplayQueuedOperation(mergedTarget));
        return waiter.promise;
      }
      // Never drop a non-coalescible or cross-entity edit silently: say why it did not go out.
      showNotice("error", "Still saving your last change. Try again in a moment.");
      return Promise.resolve(null);
    }

    const waiter = Promise.withResolvers<TelegramMiniAppClientSnapshot | null>();
    const epoch = launchEpochRef.current;
    laneRef.current = {
      phase: "inflight",
      epoch,
      operation,
      waiters: [waiter.resolve],
    };
    onWriteDispatchedRef.current?.();
    setIsMutating(true);
    setPendingOperation(operation);
    setQueuedOperation(null);
    void runMutationLane(epoch, initDataRef.current, options);
    return waiter.promise;
  }, [recordStaleAuthIntent, runMutationLane, showNotice]);

  const performMutation = useCallback(
    (operation: TelegramMiniAppOperation): Promise<TelegramMiniAppClientSnapshot | null> =>
      dispatchMutation(operation),
    [dispatchMutation],
  );

  const mutate = useCallback((operation: TelegramMiniAppOperation) => {
    void dispatchMutation(operation);
  }, [dispatchMutation]);

  const performSignedRead = useCallback(async <T>(
    operation: SignedReadOperation,
    request: () => Promise<T>,
  ): Promise<T | null> => {
    if (
      terminalRef.current
      || laneRef.current.phase !== "idle"
      || !initDataRef.current
      || !signedReadsAllowedRef.current
      || stateRef.current?.viewer.chatId == null
    ) {
      return null;
    }
    const epoch = launchEpochRef.current;
    laneRef.current = { phase: "inflight", epoch, operation, waiters: [] };
    setIsMutating(true);
    setPendingOperation(operation);
    setQueuedOperation(null);
    let shouldAutoRefresh = false;
    try {
      const response = await request();
      if (terminalRef.current || launchEpochRef.current !== epoch) return null;
      return response;
    } catch (err) {
      if (terminalRef.current || launchEpochRef.current !== epoch) return null;
      if (isMiniAppVersionMismatch(err)) {
        const reloaded = refreshMiniAppBundleOnce({
          contractVersion: err.serverContractVersion,
          catalogVersion: err.serverCatalogVersion,
        });
        if (!reloaded) {
          terminalRef.current = true;
          setUpdateRequired(true);
          onUpdateRequiredRef.current?.();
        }
        return null;
      }
      if (err instanceof MiniAppRequestError && err.status === 429 && err.code === "rate-limited") {
        const retryAfterSec = err.retryAfterSec ?? 1;
        setMutationRetryAfterSec((current) => Math.max(current, retryAfterSec));
        setAnnouncement(`Pharos edit limit reached. Settings are disabled for ${retryAfterSec} ${retryAfterSec === 1 ? "second" : "seconds"}.`);
      } else if (isStaleAuthError(err)) {
        setStaleAuth((current) => {
          if (current) return current;
          staleAuthIdRef.current += 1;
          const next = { id: staleAuthIdRef.current, intent: null };
          staleAuthRef.current = next;
          return next;
        });
        onSessionAuthExpiredRef.current();
      } else if (err instanceof MiniAppRequestError && err.code === "stale-bulk-preview") {
        showNotice("error", miniAppErrorMessage(err, "mutation"));
        shouldAutoRefresh = true;
      } else {
        showNotice("error", miniAppErrorMessage(err, "mutation"), {
          refreshAction: isAmbiguousMiniAppWriteError(err),
        });
      }
      webAppRef.current?.HapticFeedback?.notificationOccurred?.("error");
      return null;
    } finally {
      const finishedLane = readLane();
      if (finishedLane.phase !== "idle" && finishedLane.epoch === epoch) {
        laneRef.current = { phase: "idle" };
        setIsMutating(false);
        setPendingOperation(null);
        setQueuedOperation(null);
      }
      if (shouldAutoRefresh) {
        onRefreshSessionRef.current?.();
      }
    }
  }, [showNotice]);

  const performBulkWatchlistPreview = useCallback(async (
    operation: Extract<TelegramMiniAppBulkWatchlistOperation, { kind: "preview-bulk-watchlist" }>,
  ): Promise<TelegramMiniAppBulkWatchlistResponse | null> => performSignedRead(
    operation,
    () => postMiniAppBulkWatchlistPreview(MUTATE_ENDPOINT, { initData: initDataRef.current, operation }),
  ), [performSignedRead]);

  const applyBulkWatchlist = useCallback(async (addStablecoinIds: string[], removeStablecoinIds: string[]): Promise<boolean> => {
    const selection = { addStablecoinIds, removeStablecoinIds };
    if (authExpiredRef.current || staleAuthRef.current) {
      // Same visible-intent path as performMutation; never send an expired request.
      recordStaleAuthIntent({ kind: "preview-bulk-watchlist", ...selection });
      webAppRef.current?.HapticFeedback?.notificationOccurred?.("warning");
      return false;
    }
    const proof = stateRef.current?.directStateProof ?? null;
    if (proof != null) {
      // Contract v10 single-RTT proof-bearing apply: no separate preview round-trip.
      const next = await dispatchMutation(
        {
          kind: "apply-bulk-watchlist",
          ...selection,
          expectedPreferenceGeneration: proof.preferenceGeneration,
          expectedDirectFingerprint: proof.directFingerprint,
        },
        { useResponseUndo: true },
      );
      return next != null;
    }
    // Legacy rolling-deploy fallback when the session came from a pre-v10 Worker without directStateProof.
    const response = await performBulkWatchlistPreview({ kind: "preview-bulk-watchlist", ...selection });
    if (response?.result.kind !== "bulk-watchlist-preview") return false;
    const preview = response.result;
    const appliedSummary: AppliedBulkSummary = {
      added: preview.adds.length,
      removed: preview.removes.length,
      sourceImpact: preview.sourceImpact,
    };
    const next = await dispatchMutation(
      {
        kind: "confirm-bulk-watchlist",
        ...selection,
        expectedPreferenceGeneration: preview.expectedPreferenceGeneration,
        previewFingerprint: preview.previewFingerprint,
      },
      {
        appliedBulk: appliedSummary,
        undo: { kind: "undo-bulk-watchlist", ...preview.undo },
      },
    );
    return next != null;
  }, [dispatchMutation, performBulkWatchlistPreview, recordStaleAuthIntent]);

  const remove = useCallback((coin: SubscribedCoin, coveredBySource?: string | null) => new Promise<boolean>((resolve) => {
    const fire = () => void (async () => {
      const message = coveredBySource
        ? `${coin.symbol} reset to ${coveredBySource} settings.`
        : `${coin.symbol} removed.`;
      const next = await dispatchMutation(
        { kind: "remove-coin", stablecoinId: coin.stablecoinId },
        { successMessage: message, useResponseUndo: true },
      );
      resolve(next != null);
    })();
    const confirmMessage = coveredBySource
      ? `${coin.symbol} goes back to ${coveredBySource} alerts. Your changes for ${coin.symbol} are removed.`
      : `Remove ${coin.symbol} from your coins?`;
    confirmThenFire(showConfirm, confirmMessage, fire, () => resolve(false));
  }), [dispatchMutation, showConfirm]);

  const undo = useCallback(() => {
    const captured = undoOperationRef.current;
    // Never queue Undo behind a generation-advancing write; retain its expiry while busy.
    if (!captured || laneRef.current.phase !== "idle") return;
    if (
      undoRevisionRef.current != null
      && stateRevisionRef.current != null
      && stateRevisionRef.current !== undoRevisionRef.current
    ) {
      clearUndo();
      return;
    }
    // Success or failure replaces the notice (and its undo) with a visible result.
    void dispatchMutation(captured);
  }, [clearUndo, dispatchMutation]);

  const unfollowPreset = useCallback((preset: FollowedPreset) => new Promise<boolean>((resolve) => {
    // Group membership is dynamic, so always confirm when the bridge exposes a native sheet (T-48).
    confirmThenFire(showConfirm, `Unfollow ${presetCopyLabel(preset.id, preset.label)}? Coins you added yourself stay as they are.`, () => {
      void dispatchMutation({ kind: "unfollow-preset", presetId: preset.id }).then((next) => resolve(next != null));
    }, () => resolve(false));
  }), [dispatchMutation, showConfirm]);

  const pause = useCallback(() => {
    void dispatchMutation({ kind: "pause" });
  }, [dispatchMutation]);

  const unsubscribeAll = useCallback(() => {
    // R3 fix: clear any pending undo before unsubscribing-all so the snackbar cannot
    // re-add a coin to a now-empty subscriber row.
    const fire = () => {
      clearUndo();
      void dispatchMutation({ kind: "unsubscribe-all" });
    };
    confirmThenFire(showConfirm, "Unsubscribe from all alerts? This clears every coin, preset, and All stablecoins setting.", fire);
  }, [clearUndo, dispatchMutation, showConfirm]);

  const forgetMe = useCallback(() => {
    // Destructive, irreversible op: keep the confirmed state visible until
    // the server accepts deletion, then switch to the terminal view.
    const fire = () => void dispatchMutation({ kind: "forget-me" });
    if (canUseTelegramPopup(webApp)) {
      webApp!.showPopup!(
        {
          title: "Delete all my data?",
          message: "This removes your alerts, presets, and settings from Pharos. It cannot be undone.",
          buttons: [
            { id: "delete", type: "destructive", text: "Delete all my data" },
            { type: "cancel" },
          ],
        },
        (buttonId) => {
          if (buttonId === "delete") fire();
        },
      );
      return;
    }
    confirmThenFire(showConfirm, "Delete all your Pharos alert data? This cannot be undone.", () => {
      confirmThenFire(showConfirm, "Are you absolutely sure? Your alerts and settings will be deleted.", fire);
    });
  }, [dispatchMutation, showConfirm, webApp]);

  const addToHomeScreen = useCallback(() => {
    webApp?.addToHomeScreen?.();
    webApp?.HapticFeedback?.impactOccurred?.("light");
    webApp?.checkHomeScreenStatus?.((nextStatus) => {
      setHomeScreenStatus(nextStatus);
    });
  }, [webApp]);

  // Unmount cleanup: invalidate launch epoch, discard queued work, and clear the undo timer.
  useEffect(() => () => {
    launchEpochRef.current += 1;
    const lane = laneRef.current;
    laneRef.current = { phase: "idle" };
    if (lane.phase !== "idle") {
      for (const resolve of lane.waiters) resolve(null);
      if (lane.phase === "inflight+queued") {
        for (const resolve of lane.queuedWaiters) resolve(null);
      }
    }
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
  }, []);

  return {
    isMutating,
    pendingOperation,
    queuedOperation,
    mutationRetryAfterSec,
    notice,
    announcement,
    forgottenView,
    updateRequired,
    homeScreenStatus,
    staleAuth,
    getIntendedCoinValue,
    getIntendedPresetValue,
    mutate,
    performMutation,
    performBulkWatchlistPreview,
    applyBulkWatchlist,
    remove,
    undo,
    dismissNotice,
    showError,
    addToHomeScreen,
    unfollowPreset,
    pause,
    unsubscribeAll,
    forgetMe,
  };
}
