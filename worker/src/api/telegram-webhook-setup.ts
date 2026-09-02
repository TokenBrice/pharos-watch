/**
 * Two-branch setup wizard for /start onboarding.
 *
 * State lives in `telegram_pending_disambiguation` under
 * `action_type = "setup-step"` so it shares the 5-min TTL and cleanup cron
 * already in place for disambiguation flows.
 *
 * Callback namespace: `setup:*` (see telegram-webhook-callbacks.ts).
 */

import { escapeHtml, type ForceReplyMarkup, type InlineKeyboardButton, type InlineKeyboardMarkup } from "../lib/telegram";
import { buildTelegramMiniAppUrl } from "../lib/telegram-webhook-registration";
import { recordTelegramUsageEvent } from "../lib/telegram-usage-analytics";
import { MINI_APP_PAYLOAD_NAMES } from "@shared/lib/telegram-mini-app-payloads";
import { parseTelegramAdoptionToken } from "@shared/lib/telegram-adoption-analytics";
import {
  recordTelegramFirstFollow,
  recordTelegramFirstSetupComplete,
  telegramAdoptionDimensionsForStart,
} from "../lib/telegram-adoption-analytics";
import {
  TELEGRAM_PRESET_LABEL_BY_ID,
  resolveTelegramPresetTargets,
  type TelegramPresetId,
} from "../lib/telegram-presets";
import { resolveTicker } from "../lib/telegram-alerts";
import {
  buildNotFoundMessage,
  buildPresetSubscriptionSummaryMessage,
  buildPresetUnavailableMessage,
  buildStatusAmbiguousMessage,
  buildSubscriptionSummaryMessage,
} from "./telegram-webhook-messages";
import {
  canActOnPendingOwner,
  SETUP_PENDING_ACTION_TYPE,
  WIZARD_INTRO_MESSAGE,
  type SetupWizardState,
  type SetupWizardTarget,
} from "./telegram-webhook-shared";
import {
  applySubscribeIntent,
  clearPendingDisambiguation,
  loadPendingDisambiguation,
  loadSubscriptionsByIds,
  PENDING_OWNERSHIP_CONFLICT_MESSAGE,
  persistPendingDisambiguationRow,
  upsertGlobalAlertTypes,
  unixNow,
} from "./telegram-webhook-store";
import { sendAuditedTelegramReply } from "./telegram-webhook-replies";
import {
  createTelegramWebhookIntent,
  type TelegramMutationContext,
} from "./telegram-webhook-effect-fence";

const ALERT_TYPE_ORDER = ["dews", "depeg", "safety", "launch"] as const;

const ALERT_TYPE_LABELS: Record<(typeof ALERT_TYPE_ORDER)[number], string> = {
  dews: "DEWS",
  depeg: "Depeg",
  safety: "Safety",
  launch: "Launch",
};

const RECOMMENDED_ALERT_TYPES = ["dews", "depeg"] as const;
const RECOMMENDED_PRESET_ID: TelegramPresetId = "usd-top25";
const SETUP_SKIP_MESSAGE = `<b>Command reference</b>

Use /help for the full command list.

Common starts:
<code>/subscribe dews,depeg usd-top25</code>
<code>/presets</code>
<code>/settings</code>
<code>/list</code>`;

const PRESET_PICKER_ORDER: TelegramPresetId[] = [
  "usd-top10",
  "usd-top25",
  "usd-top50",
  "non-usd-top10",
  "non-usd-top25",
  "non-usd-top50",
  "eur-top10",
  "gold-top5",
  "mcap-ge-100m",
  "mcap-ge-1b",
];

function buildBranchKeyboard(options: { includeMiniAppButton?: boolean } = {}): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = [
    [{ text: "Use recommended (DEWS + Depeg, usd-top25)", callback_data: "setup:branch:recommended" }],
    [{ text: "Custom setup", callback_data: "setup:branch:custom" }],
    [{ text: "I'll type commands myself", callback_data: "setup:branch:skip" }],
  ];
  if (options.includeMiniAppButton) {
    // The recommended setup subscribes the user to a ~25-coin watchlist; the
    // most useful follow-up surface is the watchlist itself, where the new
    // coins are visible. Payload name comes from the shared registry
    // (`@shared/lib/telegram-mini-app-payloads`) so the frontend `?startapp=`
    // parser stays in sync — see T-31.
    rows.push([
      {
        text: "Open control panel",
        web_app: { url: buildTelegramMiniAppUrl(MINI_APP_PAYLOAD_NAMES.watchlist) },
      },
    ]);
  }
  return { inline_keyboard: rows };
}

function buildTypeToggleKeyboard(selected: Set<string>): InlineKeyboardMarkup {
  const rows = ALERT_TYPE_ORDER.map((type) => {
    const checked = selected.has(type) ? "✓ " : "";
    return [{ text: `${checked}${ALERT_TYPE_LABELS[type]}`, callback_data: `setup:type-toggle:${type}` }];
  });
  rows.push([
    { text: "Cancel", callback_data: "setup:cancel" },
    { text: "Next →", callback_data: "setup:next" },
  ]);
  return { inline_keyboard: rows };
}

function buildTargetKeyboard(): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = PRESET_PICKER_ORDER.map((presetId) => [
    { text: (TELEGRAM_PRESET_LABEL_BY_ID.get(presetId as TelegramPresetId) ?? presetId), callback_data: `setup:target:${presetId}` },
  ]);
  rows.push([{ text: "All tracked coins", callback_data: "setup:target:all" }]);
  rows.push([{ text: "Type a ticker", callback_data: "setup:target:type" }]);
  rows.push([{ text: "Cancel", callback_data: "setup:cancel" }]);
  return { inline_keyboard: rows };
}

function buildConfirmKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "Confirm", callback_data: "setup:confirm" },
        { text: "Cancel", callback_data: "setup:cancel" },
      ],
    ],
  };
}

function buildTickerPromptKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[{ text: "Cancel", callback_data: "setup:cancel" }]],
  };
}

function buildForceReplyKeyboard(): ForceReplyMarkup {
  return {
    force_reply: true,
    input_field_placeholder: "Type a ticker (e.g. USDC)",
    selective: false,
  };
}

function alertTypesSummary(alertTypes: readonly string[]): string {
  if (alertTypes.length === 0) return "(none — choose at least one)";
  return alertTypes
    .map((type) => ALERT_TYPE_LABELS[type as (typeof ALERT_TYPE_ORDER)[number]] ?? type)
    .join(", ");
}

function isAllowedAlertType(value: string): value is (typeof ALERT_TYPE_ORDER)[number] {
  return (ALERT_TYPE_ORDER as readonly string[]).includes(value);
}

function isKnownPresetId(value: string): value is TelegramPresetId {
  return PRESET_PICKER_ORDER.includes(value as TelegramPresetId);
}

async function persistSetupState(
  db: D1Database,
  chatId: string,
  state: SetupWizardState,
  operationStatements?: D1PreparedStatement[],
): Promise<boolean> {
  const payload = {
    step: state.step,
    alertTypes: state.alertTypes,
    target: state.target,
    ...(state.adoptionToken ? { adoptionToken: state.adoptionToken } : {}),
  };
  return persistPendingDisambiguationRow(db, {
    chatId,
    actionType: SETUP_PENDING_ACTION_TYPE,
    actionPayload: payload,
    alertTypes: [],
    resolvedIds: [],
    ambiguousTicker: "",
    candidates: [],
    remainingTickers: [],
    initiatorUserId: state.initiatorUserId,
    operationStatements,
  });
}

export function parseSetupState(
  actionPayload: string | null | undefined,
  initiatorUserId: string | null,
): SetupWizardState | null {
  if (!actionPayload) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(actionPayload);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const step = record.step;
  if (
    step !== "branch" &&
    step !== "custom-types" &&
    step !== "custom-target" &&
    step !== "awaiting-ticker" &&
    step !== "confirm-recommended" &&
    step !== "confirm-custom"
  ) {
    return null;
  }
  const alertTypes = Array.isArray(record.alertTypes)
    ? record.alertTypes.filter((value): value is string => typeof value === "string" && isAllowedAlertType(value))
    : [];
  let target: SetupWizardTarget | null = null;
  if (record.target && typeof record.target === "object") {
    const rawTarget = record.target as Record<string, unknown>;
    if (rawTarget.kind === "preset" && typeof rawTarget.presetId === "string" && isKnownPresetId(rawTarget.presetId)) {
      target = { kind: "preset", presetId: rawTarget.presetId };
    } else if (rawTarget.kind === "all") {
      target = { kind: "all" };
    } else if (
      rawTarget.kind === "ticker" &&
      typeof rawTarget.coinId === "string" &&
      typeof rawTarget.symbol === "string"
    ) {
      target = { kind: "ticker", coinId: rawTarget.coinId, symbol: rawTarget.symbol };
    }
  }
  const adoptionToken = typeof record.adoptionToken === "string"
    && parseTelegramAdoptionToken(record.adoptionToken)?.destination === "setup"
    ? record.adoptionToken
    : null;
  return { step, alertTypes, target, initiatorUserId, adoptionToken };
}

export async function sendWizardIntro(
  db: D1Database,
  botToken: string,
  chatId: string,
  initiatorUserId: string | null,
  options: Omit<TelegramMutationContext, "storedIntent"> & {
    adoptionToken?: string | null;
    includeMiniAppButton?: boolean;
  } = {},
): Promise<void> {
  const existingPending = await loadPendingDisambiguation(db, chatId);
  if (
    existingPending
    && existingPending.expires_at > unixNow()
    && existingPending.initiator_user_id != null
    && initiatorUserId != null
    && existingPending.initiator_user_id !== initiatorUserId
  ) {
    await options.beforeIrreversibleEffect?.("setup-reply");
    await sendAuditedTelegramReply(db, chatId, PENDING_OWNERSHIP_CONFLICT_MESSAGE, botToken, {
      actionDetail: "setup_conflict",
    });
    return;
  }
  const state: SetupWizardState = {
    step: "branch",
    alertTypes: [],
    target: null,
    initiatorUserId,
    adoptionToken: parseTelegramAdoptionToken(options.adoptionToken)?.destination === "setup"
      ? options.adoptionToken
      : null,
  };
  await options.planIntent?.(createTelegramWebhookIntent("command:start", {
    stage: "setup-intro",
    nextState: setupIntentState(state),
  }, "required"));
  const operationStatements = options.prepareMutationAppliedStatement
    ? [options.prepareMutationAppliedStatement()]
    : undefined;
  const persisted = options.wasMutationApplied
    ? true
    : await persistSetupState(db, chatId, state, operationStatements);
  if (!persisted) {
    throw new Error(PENDING_OWNERSHIP_CONFLICT_MESSAGE);
  }
  if (!options.wasMutationApplied && operationStatements) options.confirmAtomicMutationApplied?.();
  await options.beforeIrreversibleEffect?.("setup-reply");
  await sendAuditedTelegramReply(db, chatId, WIZARD_INTRO_MESSAGE, botToken, {
    actionDetail: "setup",
    replyMarkup: buildBranchKeyboard(options),
  });
}

interface CallbackContext extends TelegramMutationContext {
  db: D1Database;
  botToken: string;
  chatId: string;
  actorUserId: string | null;
  username: string | null;
}

async function recordSetupAdoptionMilestones(
  context: CallbackContext,
  state: SetupWizardState,
  feature: "direct" | "preset" | "global",
): Promise<void> {
  const nowSec = unixNow();
  const dimensions = telegramAdoptionDimensionsForStart(state.adoptionToken);
  await recordTelegramFirstSetupComplete(context.db, {
    ...dimensions,
    chatId: context.chatId,
    feature,
    nowSec,
  });
  await recordTelegramFirstFollow(context.db, {
    ...dimensions,
    chatId: context.chatId,
    feature,
    nowSec,
  });
}

function setupIntentState(state: SetupWizardState): Record<string, unknown> {
  return {
    step: state.step,
    alertTypes: [...state.alertTypes],
    target: state.target,
    ...(state.adoptionToken ? { adoptionToken: state.adoptionToken } : {}),
  };
}

async function persistSetupTransition(
  context: CallbackContext,
  action: string,
  nextState: SetupWizardState,
): Promise<void> {
  await context.planIntent?.(createTelegramWebhookIntent("callback:setup", {
    action,
    nextState: setupIntentState(nextState),
  }, "required"));
  if (context.wasMutationApplied) return;
  const operationStatements = context.prepareMutationAppliedStatement
    ? [context.prepareMutationAppliedStatement()]
    : undefined;
  await persistSetupState(context.db, context.chatId, nextState, operationStatements);
  if (operationStatements) context.confirmAtomicMutationApplied?.();
}

async function clearSetupTransition(
  context: CallbackContext,
  action: string,
  state: SetupWizardState,
): Promise<void> {
  await context.planIntent?.(createTelegramWebhookIntent("callback:setup", {
    action,
    previousState: setupIntentState(state),
  }, "required"));
  if (context.wasMutationApplied) return;
  const operationStatements = context.prepareMutationAppliedStatement
    ? [context.prepareMutationAppliedStatement()]
    : undefined;
  await clearPendingDisambiguation(context.db, context.chatId, { operationStatements });
  if (operationStatements) context.confirmAtomicMutationApplied?.();
}

export async function handleSetupBranch(
  context: CallbackContext,
  arg: string,
  state: SetupWizardState | null,
): Promise<{ text: string }> {
  if (state == null) {
    return { text: "Setup expired. Send /start to begin again." };
  }
  if (!canActOnPendingOwner(state.initiatorUserId, context.actorUserId)) {
    return { text: "Only the user who started this setup can continue." };
  }

  if (arg === "recommended") {
    await recordTelegramUsageEvent(context.db, {
      eventType: "setup_choice",
      sourceCategory: "wizard",
      actionDetail: "recommended",
      outcome: "selected",
    });
    return openRecommendedConfirm(context, state);
  }
  if (arg === "custom") {
    await recordTelegramUsageEvent(context.db, {
      eventType: "setup_choice",
      sourceCategory: "wizard",
      actionDetail: "custom",
      outcome: "selected",
    });
    const nextState: SetupWizardState = {
      ...state,
      step: "custom-types",
      alertTypes: [...RECOMMENDED_ALERT_TYPES],
    };
    await persistSetupTransition(context, "branch-custom", nextState);
    await sendSetupReply(
      context,
      "Pick alert types, then tap Next.\n\n" +
        "<b>Alert types</b>\n" +
        "- DEWS — stress score reaches an alert band\n" +
        "- Depeg — coin trades off peg\n" +
        "- Safety — Safety grade changes\n" +
        "- Launch — pre-launch coin goes live on Pharos",
      {
        replyMarkup: buildTypeToggleKeyboard(new Set(nextState.alertTypes)),
      },
    );
    return { text: "Pick alert types." };
  }
  if (arg === "skip") {
    await clearSetupTransition(context, "branch-skip", state);
    await recordTelegramUsageEvent(context.db, {
      eventType: "setup_choice",
      sourceCategory: "wizard",
      actionDetail: "skip",
      outcome: "selected",
    });
    await sendSetupReply(context, SETUP_SKIP_MESSAGE);
    return { text: "OK." };
  }
  return { text: "Action not recognized." };
}

async function openRecommendedConfirm(
  context: CallbackContext,
  state: SetupWizardState,
): Promise<{ text: string }> {
  const preview = await previewPresetCoins(context.db, RECOMMENDED_PRESET_ID);
  if (preview == null) {
    return { text: "Preset data unavailable. Try again in a moment." };
  }

  const nextState: SetupWizardState = {
    step: "confirm-recommended",
    alertTypes: [...RECOMMENDED_ALERT_TYPES],
    target: { kind: "preset", presetId: RECOMMENDED_PRESET_ID },
    initiatorUserId: state.initiatorUserId,
  };
  await persistSetupTransition(context, "branch-recommended", nextState);

  const head = `You'll get DEWS and Depeg alerts for these ${preview.count} coins:`;
  const body = preview.symbolPreview;
  await sendSetupReply(context, escapeHtml(`${head}\n${body}`), {
    replyMarkup: buildConfirmKeyboard(),
  });
  return { text: "Review and confirm." };
}

async function previewPresetCoins(
  db: D1Database,
  presetId: TelegramPresetId,
): Promise<{ count: number; symbolPreview: string } | null> {
  const result = await resolveTelegramPresetTargets(db, [presetId]);
  if (result.kind !== "ok") return null;
  const coins = result.presets.flatMap((preset) => preset.coins);
  const symbols = coins.map((coin) => coin.symbol);
  const head = symbols.slice(0, 10).join(", ");
  const more = coins.length > 10 ? ` ... and ${coins.length - 10} more` : "";
  return { count: coins.length, symbolPreview: `${head}${more}` };
}

export async function handleSetupTypeToggle(
  context: CallbackContext,
  arg: string,
  state: SetupWizardState | null,
): Promise<{ text: string }> {
  if (!state || state.step !== "custom-types") {
    return { text: "Setup expired. Send /start to begin again." };
  }
  if (!canActOnPendingOwner(state.initiatorUserId, context.actorUserId)) {
    return { text: "Only the user who started this setup can continue." };
  }
  if (!isAllowedAlertType(arg)) {
    return { text: "Action not recognized." };
  }
  const selected = new Set(state.alertTypes);
  if (selected.has(arg)) {
    selected.delete(arg);
  } else {
    selected.add(arg);
  }
  const nextAlertTypes = ALERT_TYPE_ORDER.filter((type) => selected.has(type));
  const nextState: SetupWizardState = { ...state, alertTypes: nextAlertTypes };
  await persistSetupTransition(context, "type-toggle", nextState);
  await sendSetupReply(
    context,
    `Selected: ${alertTypesSummary(nextAlertTypes)}`,
    { replyMarkup: buildTypeToggleKeyboard(selected) },
  );
  return { text: ALERT_TYPE_LABELS[arg] };
}

export async function handleSetupNext(
  context: CallbackContext,
  state: SetupWizardState | null,
): Promise<{ text: string }> {
  if (!state || state.step !== "custom-types") {
    return { text: "Setup expired. Send /start to begin again." };
  }
  if (!canActOnPendingOwner(state.initiatorUserId, context.actorUserId)) {
    return { text: "Only the user who started this setup can continue." };
  }
  if (state.alertTypes.length === 0) {
    return { text: "Pick at least one alert type first." };
  }
  const nextState: SetupWizardState = { ...state, step: "custom-target" };
  await persistSetupTransition(context, "next", nextState);
  await sendSetupReply(
    context,
    `Selected alerts: ${alertTypesSummary(state.alertTypes)}\nPick a target watchlist:`,
    { replyMarkup: buildTargetKeyboard() },
  );
  return { text: "Pick a target." };
}

export async function handleSetupTarget(
  context: CallbackContext,
  arg: string,
  state: SetupWizardState | null,
): Promise<{ text: string }> {
  if (!state || state.step !== "custom-target") {
    return { text: "Setup expired. Send /start to begin again." };
  }
  if (!canActOnPendingOwner(state.initiatorUserId, context.actorUserId)) {
    return { text: "Only the user who started this setup can continue." };
  }

  if (arg === "type") {
    const nextState: SetupWizardState = { ...state, step: "awaiting-ticker" };
    await persistSetupTransition(context, "target-type", nextState);
    await sendSetupReply(
      context,
      "Reply with a ticker (e.g. USDC) or send /cancel to abort.",
      { replyMarkup: buildTickerPromptKeyboard() },
    );
    return { text: "Type a ticker." };
  }

  if (arg === "all") {
    return advanceToCustomConfirm(context, state, { kind: "all" });
  }

  if (isKnownPresetId(arg)) {
    return advanceToCustomConfirm(context, state, { kind: "preset", presetId: arg });
  }

  return { text: "Action not recognized." };
}

async function advanceToCustomConfirm(
  context: CallbackContext,
  state: SetupWizardState,
  target: SetupWizardTarget,
): Promise<{ text: string }> {
  let summary: string;
  if (target.kind === "preset") {
    const preview = await previewPresetCoins(context.db, target.presetId as TelegramPresetId);
    if (preview == null) {
      return { text: "Preset data unavailable. Try again in a moment." };
    }
    summary = `You'll get ${alertTypesSummary(state.alertTypes)} alerts for these ${preview.count} coins:\n${preview.symbolPreview}`;
  } else if (target.kind === "all") {
    summary = `You'll get ${alertTypesSummary(state.alertTypes)} alerts across all tracked coins.`;
  } else {
    summary = `You'll get ${alertTypesSummary(state.alertTypes)} alerts for ${target.symbol}.`;
  }

  const nextState: SetupWizardState = { ...state, step: "confirm-custom", target };
  await persistSetupTransition(context, "target-confirm", nextState);
  await sendSetupReply(context, escapeHtml(summary), {
    replyMarkup: buildConfirmKeyboard(),
  });
  return { text: "Review and confirm." };
}

export async function handleSetupTickerInput(
  context: CallbackContext,
  text: string,
  state: SetupWizardState,
): Promise<void> {
  if (!canActOnPendingOwner(state.initiatorUserId, context.actorUserId)) {
    return;
  }
  const resolution = resolveTicker(text.trim());
  if (resolution.status === "not_found") {
    await sendSetupReply(
      context,
      buildNotFoundMessage(text.trim(), resolution.suggestion),
      { replyMarkup: buildForceReplyKeyboard() },
    );
    return;
  }
  if (resolution.status === "ambiguous") {
    await sendSetupReply(
      context,
      buildStatusAmbiguousMessage(text.trim(), resolution.matches),
      { replyMarkup: buildForceReplyKeyboard() },
    );
    return;
  }
  const coin = resolution.matches[0];
  await advanceToCustomConfirm(context, state, {
    kind: "ticker",
    coinId: coin.id,
    symbol: coin.symbol,
  });
}

export async function handleSetupConfirm(
  context: CallbackContext,
  state: SetupWizardState | null,
): Promise<{ text: string }> {
  if (!state || (state.step !== "confirm-recommended" && state.step !== "confirm-custom")) {
    return { text: "Setup expired. Send /start to begin again." };
  }
  if (!canActOnPendingOwner(state.initiatorUserId, context.actorUserId)) {
    return { text: "Only the user who started this setup can continue." };
  }
  if (state.alertTypes.length === 0 || state.target == null) {
    return { text: "Setup incomplete. Send /start to begin again." };
  }

  const alertTypes = new Set(state.alertTypes);
  await context.planIntent?.(createTelegramWebhookIntent("callback:setup", {
    action: "confirm",
    state: setupIntentState(state),
  }, "required"));
  const operationStatements = context.prepareMutationAppliedStatement
    ? [context.prepareMutationAppliedStatement()]
    : undefined;

  if (state.target.kind === "all") {
    if (!context.wasMutationApplied) {
      await upsertGlobalAlertTypes(context.db, context.chatId, context.username, alertTypes, {
        clearPending: true,
        operationStatements,
      });
      if (operationStatements) context.confirmAtomicMutationApplied?.();
    }
    await recordSetupAdoptionMilestones(context, state, "global");
    await recordTelegramUsageEvent(context.db, {
      eventType: "setup_complete",
      sourceCategory: state.step === "confirm-recommended" ? "recommended" : "custom",
      actionDetail: "all",
      outcome: "success",
    });
    await recordTelegramUsageEvent(context.db, {
      eventType: "global_alert_change",
      actionDetail: "setup",
      outcome: "opt_in",
    });
    await sendSetupReply(
      context,
      escapeHtml(`Subscribed: ${alertTypesSummary(state.alertTypes)} on all tracked coins.`),
    );
    return { text: "Subscribed." };
  }

  if (state.target.kind === "preset") {
    const result = await resolveTelegramPresetTargets(context.db, [state.target.presetId as TelegramPresetId]);
    if (result.kind !== "ok") {
      await sendSetupReply(context, buildPresetUnavailableMessage());
      return { text: "Preset data unavailable." };
    }
    const coins = result.presets.flatMap((preset) => preset.coins);
    if (!context.wasMutationApplied) {
      await applySubscribeIntent(context.db, {
        chatId: context.chatId,
        username: context.username,
        alertTypes,
        directStablecoinIds: [],
        presetIds: [state.target.presetId as TelegramPresetId],
        clearPending: true,
        operationStatements,
      });
      if (operationStatements) context.confirmAtomicMutationApplied?.();
    }
    await recordSetupAdoptionMilestones(context, state, "preset");
    await recordTelegramUsageEvent(context.db, {
      eventType: "setup_complete",
      sourceCategory: state.step === "confirm-recommended" ? "recommended" : "custom",
      actionDetail: "preset",
      outcome: "success",
    });
    await recordTelegramUsageEvent(context.db, {
      eventType: "preset_follow",
      actionDetail: "setup",
      outcome: "success",
    });
    await sendSetupReply(
      context,
      buildPresetSubscriptionSummaryMessage([], {
        presetIds: [state.target.presetId as TelegramPresetId],
        presetLabelById: TELEGRAM_PRESET_LABEL_BY_ID,
        presetCoinCount: coins.length,
      }),
    );
    return { text: "Subscribed." };
  }

  // ticker target
  if (!context.wasMutationApplied) {
    await applySubscribeIntent(context.db, {
      chatId: context.chatId,
      username: context.username,
      alertTypes,
      directStablecoinIds: [state.target.coinId],
      clearPending: true,
      operationStatements,
    });
    if (operationStatements) context.confirmAtomicMutationApplied?.();
  }
  await recordSetupAdoptionMilestones(context, state, "direct");
  await recordTelegramUsageEvent(context.db, {
    eventType: "setup_complete",
    sourceCategory: "custom",
    actionDetail: "ticker",
    outcome: "success",
  });
  const subscriptions = await loadSubscriptionsByIds(context.db, context.chatId, [state.target.coinId]);
  await sendSetupReply(
    context,
    buildSubscriptionSummaryMessage(`Subscribed for ${state.target.symbol}.`, subscriptions),
  );
  return { text: "Subscribed." };
}

export async function handleSetupCancel(
  context: CallbackContext,
  state: SetupWizardState | null,
): Promise<{ text: string }> {
  if (state == null) {
    return { text: "Setup expired. Send /start to begin again." };
  }
  if (!canActOnPendingOwner(state.initiatorUserId, context.actorUserId)) {
    return { text: "Only the user who started this setup can cancel." };
  }
  await clearSetupTransition(context, "cancel", state);
  await sendSetupReply(context, "Setup cancelled. Send /start to begin again.");
  return { text: "Cancelled." };
}

async function sendSetupReply(
  context: CallbackContext,
  message: string,
  options: { replyMarkup?: unknown } = {},
): Promise<void> {
  await context.beforeIrreversibleEffect?.("setup-reply");
  await sendAuditedTelegramReply(context.db, context.chatId, message, context.botToken, {
    ...options,
    actionDetail: "setup",
  });
}
