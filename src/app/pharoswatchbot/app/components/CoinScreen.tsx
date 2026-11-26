"use client";

import { Fragment, useCallback } from "react";
import { ExternalLink, MessageCircle } from "lucide-react";
import { TELEGRAM_BOT_URL } from "@shared/lib/telegram-bot-registration";
import { isPausedSentinel, isTelegramSnoozeActive } from "@shared/lib/telegram-delivery-policy";
import {
  ALERT_DESCRIPTIONS,
  ALERT_LABELS,
  DEFAULT_COIN_ALERTS,
  DEPEG_STEP_OPTIONS,
  DEWS_BAND_OPTIONS,
  DEWS_SCORE_SUBTITLE,
  LIVE_ALERT_TYPES,
  PHAROS_COIN_PAGE_PREFIX,
  SNOOZE_DURATION_LABELS,
  SNOOZE_DURATION_TOKENS,
  depegStepSubtitle,
} from "../constants";
import {
  coinCoverage,
  coinInheritedCoverSource,
  displayCoinName,
  formatClock,
  formatSnoozeUntil,
  isCoverageActive,
  type FamilyCoverage,
} from "../format";
import { usePrimaryAction } from "../primary-action";
import type { TelegramWebAppSdk } from "../telegram-sdk";
import type { MiniAppScreen } from "../use-mini-app-view";
import type { MiniAppScreenProps, SubscribedCoin, TelegramAlertType, TelegramMiniAppOperation } from "../types";
import { ChoiceChips, ListRow, ListSection, SelectRow, Switch } from "./List";

/** Native <select> values are strings; null tuning (the default) maps to this token. */
const DEFAULT_VALUE = "default";
function toSelectValue(value: string | number | null): string {
  return value == null ? DEFAULT_VALUE : String(value);
}
function selectOptions<T extends string | number>(options: readonly { value: T | null; label: string }[]) {
  return options.map((option) => ({ value: option.value == null ? DEFAULT_VALUE : String(option.value), label: option.label }));
}
const DEWS_SELECT_OPTIONS = selectOptions(DEWS_BAND_OPTIONS);
const DEPEG_SELECT_OPTIONS = selectOptions(DEPEG_STEP_OPTIONS);

function coverageSubtitle(type: TelegramAlertType, coverage: FamilyCoverage, symbol: string): string {
  const description = ALERT_DESCRIPTIONS[type];
  switch (coverage.kind) {
    case "via":
      return `${description}. On via ${coverage.source}.`;
    case "muted":
      return `Off for ${symbol}. ${coverage.source} would cover it.`;
    case "unknown":
      return `Can't check ${coverage.source} coverage right now`;
    default:
      return description;
  }
}

export interface CoinScreenProps extends MiniAppScreenProps {
  coinId: string;
  webApp: TelegramWebAppSdk | null;
  onRemove: (coin: SubscribedCoin, coveredBySource?: string | null) => void;
  push?: (screen: MiniAppScreen) => void;
}

export function CoinScreen({
  state,
  nowSec,
  canEdit,
  busy,
  rateLimited = false,
  pendingOperation,
  queuedOperation = null,
  getIntendedCoinValue,
  presetMemberSetById,
  onMutate,
  coinId,
  webApp,
  onRemove,
  push,
}: CoinScreenProps) {
  const subscription = state.subscriptions.find((coin) => coin.stablecoinId === coinId) ?? null;
  const catalogCoin = state.catalog.searchableCoins.find((coin) => coin.stablecoinId === coinId) ?? null;
  const symbol = subscription?.symbol ?? catalogCoin?.symbol ?? coinId;
  const name = subscription?.name ?? catalogCoin?.name ?? null;
  const secondaryName = displayCoinName(symbol, name);
  const tracked = catalogCoin != null;
  const coverage = coinCoverage(coinId, subscription, state, presetMemberSetById);
  const controlsDisabled = !canEdit || busy;
  const timezone = state.subscriber.quietHours.timezone;
  const pendingSetCoin = pendingOperation?.kind === "set-coin" && pendingOperation.stablecoinId === coinId ? pendingOperation : null;
  const queuedSetCoin = queuedOperation?.kind === "set-coin" && queuedOperation.stablecoinId === coinId ? queuedOperation : null;
  const followPending = pendingSetCoin != null;
  // Sibling switches & pickers on THIS coin stay interactive while a set-coin for
  // THIS coin is in flight so additional taps coalesce instead of dimming the screen.
  const canCoalesceThisCoin = subscription != null && !rateLimited && pendingSetCoin != null;
  const coinControlsDisabled = !canEdit || rateLimited || (busy && !canCoalesceThisCoin);
  const anyInherited = LIVE_ALERT_TYPES.some((type) => coverage[type].kind === "via");
  const inheritedCoverSource = coinInheritedCoverSource(coinId, state, presetMemberSetById);

  const followAlertTypes = (() => {
    const inherited = LIVE_ALERT_TYPES.filter((type) => coverage[type].kind === "via");
    if (inherited.length === 0) return DEFAULT_COIN_ALERTS;
    return Object.fromEntries(inherited.map((type) => [type, true])) as Partial<Record<TelegramAlertType, boolean>>;
  })();

  usePrimaryAction(canEdit && tracked && !subscription ? {
    kind: "follow-coin",
    text: anyInherited ? `Customize ${symbol}` : `Follow ${symbol}`,
    progress: followPending,
    onClick: () => {
      if (!busy) onMutate({ kind: "set-coin", stablecoinId: coinId, patch: { alertTypes: followAlertTypes } });
    },
  } : null);

  const setCoin = useCallback((patch: Extract<TelegramMiniAppOperation, { kind: "set-coin" }>["patch"]) => {
    onMutate({ kind: "set-coin", stablecoinId: coinId, patch });
  }, [coinId, onMutate]);

  const handleDewsBandChange = useCallback((next: string) => {
    setCoin({ dewsMinBand: next === DEFAULT_VALUE ? null : next as "WARNING" | "DANGER" });
  }, [setCoin]);

  const handleDepegStepChange = useCallback((next: string) => {
    setCoin({ depegStepBps: next === DEFAULT_VALUE ? null : Number(next) as 100 | 250 | 500 });
  }, [setCoin]);

  const pendingFamily = (type: TelegramAlertType) =>
    pendingSetCoin != null && (
      pendingSetCoin.patch.alertTypes?.[type] !== undefined
      || (type === "reserve" && pendingSetCoin.patch.reserve !== undefined)
      || (type === "freeze" && pendingSetCoin.patch.freeze !== undefined)
    );
  const queuedFamily = (type: TelegramAlertType) =>
    queuedSetCoin?.patch.alertTypes?.[type] !== undefined;
  const pendingTuning = (field: "dewsMinBand" | "depegStepBps" | "safetyMode") =>
    pendingSetCoin != null && field in pendingSetCoin.patch;
  const queuedTuning = (field: "dewsMinBand" | "depegStepBps" | "safetyMode") =>
    queuedSetCoin != null && field in queuedSetCoin.patch;
  const chatSnoozeUntil = state.subscriber.snoozeUntilTs;
  const chatPaused = chatSnoozeUntil != null && isTelegramSnoozeActive(chatSnoozeUntil, nowSec);
  const coinSnoozeUntil = subscription?.snoozeUntilTs ?? null;
  const coinSnoozed = coinSnoozeUntil != null && coinSnoozeUntil > nowSec;
  const canSnoozeCoin = tracked && (subscription != null || anyInherited);
  const openBot = (url: string) => {
    if (webApp?.openTelegramLink) webApp.openTelegramLink(url);
    else webApp?.openLink?.(url);
  };

  return (
    <>
      <header className="px-1 pt-2">
        <h1 tabIndex={-1} className="outline-none text-2xl font-semibold tracking-tight text-foreground">{symbol}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {[secondaryName, catalogCoin?.pegLabel ?? (catalogCoin?.peg ? `${catalogCoin.peg} peg` : null)].filter(Boolean).join(" · ")
            || (tracked ? null : "Pharos no longer tracks this coin")}
        </p>
        {chatPaused && chatSnoozeUntil != null ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {isPausedSentinel(chatSnoozeUntil)
              ? "All alerts are paused until you resume."
              : <>All alerts are paused until <span className="tabular-nums">{formatClock(chatSnoozeUntil, timezone, nowSec)}</span>.</>}
          </p>
        ) : null}
        {tracked && !subscription && !anyInherited ? (
          <p className="mt-1 text-sm text-muted-foreground">Not in your coins yet.</p>
        ) : null}
      </header>

      {tracked ? (
        <ListSection
          title={`Alerts for ${symbol}`}
          className="mt-5"
          footer={!subscription
            ? anyInherited
              ? `Customize ${symbol} to turn alerts off or tune thresholds.`
              : `Follow ${symbol} to choose its alerts.`
            : anyInherited
              ? `Turning one off disables it for ${symbol} only.`
              : undefined}
        >
          {LIVE_ALERT_TYPES.map((type) => {
            const entry = coverage[type];
            const on = entry.kind === "on";
            const confirmedChecked = isCoverageActive(entry);
            const subtitle = coverageSubtitle(type, entry, symbol);
            const showSwitch = subscription != null && entry.kind !== "unknown";
            return (
              <Fragment key={type}>
                <ListRow
                  title={ALERT_LABELS[type]}
                  subtitle={subtitle}
                  className="min-h-[3.25rem]"
                  // An unfollowed coin is read-only (no switch that would silently follow it),
                  // and unreadable preset coverage renders "—" with no switch (rule R2).
                  value={showSwitch ? undefined : entry.kind === "unknown" ? "—" : confirmedChecked ? "On" : "Off"}
                  trailing={showSwitch ? (
                    <Switch
                      label={`${symbol} ${ALERT_LABELS[type]}`}
                      description={subtitle}
                      checked={confirmedChecked}
                      disabled={coinControlsDisabled}
                      allowWhileLoading={canCoalesceThisCoin}
                      loading={pendingFamily(type)}
                      queued={queuedFamily(type)}
                      onChange={() => {
                        const intended = getIntendedCoinValue
                          ? getIntendedCoinValue(coinId, type, confirmedChecked)
                          : confirmedChecked;
                        setCoin({ alertTypes: { [type]: !intended } });
                      }}
                    />
                  ) : undefined}
                />
                {on && type === "dews" && subscription ? (
                  <SelectRow
                    inset
                    id={`coin-${coinId}-dews`}
                    title="Minimum level"
                    subtitle={DEWS_SCORE_SUBTITLE}
                    value={toSelectValue(subscription.dewsMinBand === "ALERT" ? null : subscription.dewsMinBand)}
                    options={DEWS_SELECT_OPTIONS}
                    disabled={coinControlsDisabled}
                    allowWhileLoading={canCoalesceThisCoin}
                    loading={pendingTuning("dewsMinBand")}
                    queued={queuedTuning("dewsMinBand")}
                    onChange={handleDewsBandChange}
                  />
                ) : null}
                {on && type === "depeg" && subscription ? (
                  <SelectRow
                    inset
                    id={`coin-${coinId}-depeg`}
                    title="Alert at"
                    subtitle={depegStepSubtitle(subscription.depegStepBps, symbol)}
                    value={toSelectValue(subscription.depegStepBps)}
                    options={DEPEG_SELECT_OPTIONS}
                    disabled={coinControlsDisabled}
                    allowWhileLoading={canCoalesceThisCoin}
                    loading={pendingTuning("depegStepBps")}
                    queued={queuedTuning("depegStepBps")}
                    onChange={handleDepegStepChange}
                  />
                ) : null}
                {on && type === "safety" && subscription && subscription.safetyMode === "upgrade-only" ? (
                  <ListRow
                    wrap
                    className="pl-8 before:hidden"
                    title={<span className="text-xs text-muted-foreground">Live downgrade alerts are off</span>}
                    trailing={(
                      <ChoiceChips
                        label={`Turn on live downgrade alerts for ${symbol}`}
                        options={[{ value: "on", label: "Turn on" }]}
                        disabled={coinControlsDisabled}
                        allowWhileLoading={canCoalesceThisCoin}
                        pendingValue={pendingTuning("safetyMode") ? "on" : null}
                        queuedValue={queuedTuning("safetyMode") ? "on" : null}
                        onSelect={() => setCoin({ safetyMode: null })}
                      />
                    )}
                  />
                ) : null}
              </Fragment>
            );
          })}
        </ListSection>
      ) : null}

      {tracked ? (
        <ListSection>
          {canSnoozeCoin ? (
            coinSnoozed && coinSnoozeUntil != null ? (
              <ListRow
                wrap
                title={<span className="tabular-nums">{formatSnoozeUntil(coinSnoozeUntil, timezone, nowSec)}</span>}
                trailing={(
                  <ChoiceChips
                    label={`Clear ${symbol} snooze`}
                    options={[{ value: "clear", label: "Clear", ariaLabel: `Clear ${symbol} snooze` }]}
                    disabled={controlsDisabled}
                    pendingValue={pendingOperation?.kind === "set-coin-snooze" && pendingOperation.stablecoinId === coinId ? "clear" : null}
                    onSelect={() => onMutate({ kind: "set-coin-snooze", stablecoinId: coinId, durationToken: "clear" })}
                  />
                )}
              />
            ) : (
              <ListRow
                wrap
                title={`Snooze ${symbol}`}
                trailing={(
                  <ChoiceChips
                    label={`Snooze ${symbol}`}
                    options={SNOOZE_DURATION_TOKENS.map((token) => ({ value: token, label: token, ariaLabel: `Snooze ${symbol} for ${SNOOZE_DURATION_LABELS[token]}` }))}
                    disabled={controlsDisabled}
                    pendingValue={pendingOperation?.kind === "set-coin-snooze" && pendingOperation.stablecoinId === coinId ? pendingOperation.durationToken : null}
                    onSelect={(token) => onMutate({ kind: "set-coin-snooze", stablecoinId: coinId, durationToken: token })}
                  />
                )}
              />
            )
          ) : null}
          <ListRow
            title="View on Pharos"
            trailing={<ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
            disabled={!webApp}
            onClick={() => webApp?.openLink?.(`${PHAROS_COIN_PAGE_PREFIX}${coinId}`)}
          />
          <ListRow
            title="Send status to chat"
            subtitle="Current peg, DEWS and Safety Score from the bot"
            trailing={<MessageCircle className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
            disabled={!webApp}
            onClick={() => openBot(`${TELEGRAM_BOT_URL}?start=status_${coinId}`)}
          />
        </ListSection>
      ) : (
        <ListSection className="mt-5">
          <ListRow
            title="Pharos no longer tracks this coin"
            subtitle={subscription ? "Removing it clears this stored coin permanently." : "It is not in the current catalog."}
          />
          {!subscription && push ? (
            <ListRow
              title="Browse coins"
              tone="accent"
              chevron
              onClick={() => push({ name: "add-coins" })}
            />
          ) : null}
        </ListSection>
      )}

      {subscription && canEdit ? (
        <ListSection>
          {inheritedCoverSource ? (
            <ListRow
              title={`Use ${inheritedCoverSource} settings for ${symbol}`}
              tone="default"
              disabled={busy}
              loading={pendingOperation?.kind === "remove-coin" && pendingOperation.stablecoinId === coinId}
              onClick={() => onRemove(subscription, inheritedCoverSource)}
            />
          ) : (
            <ListRow
              title={`Remove ${symbol} from my coins`}
              tone="destructive"
              disabled={busy}
              loading={pendingOperation?.kind === "remove-coin" && pendingOperation.stablecoinId === coinId}
              onClick={() => onRemove(subscription, null)}
            />
          )}
        </ListSection>
      ) : null}
    </>
  );
}
