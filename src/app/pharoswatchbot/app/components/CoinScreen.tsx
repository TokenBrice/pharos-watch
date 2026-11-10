"use client";

import { Fragment } from "react";
import { ExternalLink, MessageCircle } from "lucide-react";
import { formatWhyPayload } from "@shared/lib/telegram-mini-app-payloads";
import { TELEGRAM_BOT_URL } from "@shared/lib/telegram-bot-registration";
import {
  ALERT_DESCRIPTIONS,
  ALERT_LABELS,
  DEFAULT_COIN_ALERTS,
  DEPEG_STEP_OPTIONS,
  DEWS_BAND_OPTIONS,
  LIVE_ALERT_TYPES,
  PHAROS_COIN_PAGE_PREFIX,
  SAFETY_MODE_OPTIONS,
  SNOOZE_DURATION_LABELS,
  SNOOZE_DURATION_TOKENS,
} from "../constants";
import { coinCoverage, formatSnoozeUntil, isCoverageActive, type FamilyCoverage } from "../format";
import { usePrimaryAction } from "../primary-action";
import type { TelegramWebAppSdk } from "../telegram-sdk";
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

function coverageSubtitle(type: TelegramAlertType, coverage: FamilyCoverage, symbol: string): string {
  switch (coverage.kind) {
    case "via":
      return `On via ${coverage.source}`;
    case "muted":
      return `Muted for ${symbol} (${coverage.source} covers it)`;
    case "unknown":
      return `Can't check ${coverage.source} coverage right now`;
    default:
      return ALERT_DESCRIPTIONS[type];
  }
}

export interface CoinScreenProps extends MiniAppScreenProps {
  coinId: string;
  webApp: TelegramWebAppSdk | null;
  onRemove: (coin: SubscribedCoin) => void;
}

export function CoinScreen({ state, nowSec, canEdit, busy, pendingOperation, onMutate, coinId, webApp, onRemove }: CoinScreenProps) {
  const subscription = state.subscriptions.find((coin) => coin.stablecoinId === coinId) ?? null;
  const catalogCoin = state.catalog.searchableCoins.find((coin) => coin.stablecoinId === coinId) ?? null;
  const symbol = subscription?.symbol ?? catalogCoin?.symbol ?? coinId;
  const name = subscription?.name ?? catalogCoin?.name ?? null;
  const tracked = catalogCoin != null;
  const coverage = coinCoverage(coinId, subscription, state);
  const controlsDisabled = !canEdit || busy;
  const timezone = state.subscriber.quietHours.timezone;
  const pendingSetCoin = pendingOperation?.kind === "set-coin" && pendingOperation.stablecoinId === coinId ? pendingOperation : null;
  const followPending = pendingSetCoin != null;

  usePrimaryAction(canEdit && tracked && !subscription ? {
    text: `Follow ${symbol}`,
    progress: followPending,
    onClick: () => {
      if (!busy) onMutate({ kind: "set-coin", stablecoinId: coinId, patch: { alertTypes: DEFAULT_COIN_ALERTS } });
    },
  } : null);

  const setCoin = (patch: Extract<TelegramMiniAppOperation, { kind: "set-coin" }>["patch"]) => {
    webApp?.HapticFeedback?.selectionChanged?.();
    onMutate({ kind: "set-coin", stablecoinId: coinId, patch });
  };
  const pendingFamily = (type: TelegramAlertType) => pendingSetCoin?.patch.alertTypes?.[type] != null;
  const pendingTuning = (field: "dewsMinBand" | "depegStepBps" | "safetyMode") =>
    pendingSetCoin != null && field in pendingSetCoin.patch;
  const coinSnoozeUntil = subscription?.snoozeUntilTs ?? null;
  const coinSnoozed = coinSnoozeUntil != null && coinSnoozeUntil > nowSec;
  const anyInherited = LIVE_ALERT_TYPES.some((type) => coverage[type].kind === "via");
  const openBot = (url: string) => {
    if (webApp?.openTelegramLink) webApp.openTelegramLink(url);
    else webApp?.openLink?.(url);
  };

  return (
    <>
      <header className="px-1 pt-2">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">{symbol}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {[name !== symbol ? name : null, catalogCoin?.pegLabel ?? (catalogCoin?.peg ? `${catalogCoin.peg} peg` : null)].filter(Boolean).join(" · ")
            || (tracked ? null : "No longer tracked by Pharos")}
        </p>
        {tracked && !subscription ? <p className="mt-1 text-sm text-muted-foreground">Not in your coins yet.</p> : null}
      </header>

      {tracked ? (
        <ListSection
          title={`Alerts for ${symbol}`}
          className="mt-5"
          footer={!subscription
            ? `Follow ${symbol} to choose its alerts.`
            : anyInherited ? `Turning one of these off mutes it for ${symbol} only.` : undefined}
        >
          {LIVE_ALERT_TYPES.map((type) => {
            const entry = coverage[type];
            const on = entry.kind === "on";
            const subtitle = coverageSubtitle(type, entry, symbol);
            return (
              <Fragment key={type}>
                <ListRow
                  title={ALERT_LABELS[type]}
                  subtitle={subtitle}
                  className="min-h-[3.25rem]"
                  // An unfollowed coin is read-only: a switch here would silently follow it.
                  // Unreadable coverage is shown as the missing-value dash, never as "Off".
                  value={subscription ? undefined : entry.kind === "unknown" ? "—" : isCoverageActive(entry) ? "On" : "Off"}
                  trailing={subscription ? (
                    <Switch
                      label={`${symbol} ${ALERT_LABELS[type]}`}
                      description={subtitle}
                      checked={isCoverageActive(entry)}
                      disabled={controlsDisabled || entry.kind === "unknown"}
                      loading={pendingFamily(type)}
                      onChange={(next) => setCoin({ alertTypes: { [type]: next } })}
                    />
                  ) : undefined}
                />
                {on && type === "dews" && subscription ? (
                  <SelectRow
                    inset
                    id={`coin-${coinId}-dews`}
                    title="Alert from"
                    value={toSelectValue(subscription.dewsMinBand === "ALERT" ? null : subscription.dewsMinBand)}
                    options={selectOptions(DEWS_BAND_OPTIONS)}
                    disabled={controlsDisabled}
                    loading={pendingTuning("dewsMinBand")}
                    onChange={(next) => setCoin({ dewsMinBand: next === DEFAULT_VALUE ? null : next as "WARNING" | "DANGER" })}
                  />
                ) : null}
                {on && type === "depeg" && subscription ? (
                  <SelectRow
                    inset
                    id={`coin-${coinId}-depeg`}
                    title="Re-alert"
                    value={toSelectValue(subscription.depegStepBps)}
                    options={selectOptions(DEPEG_STEP_OPTIONS)}
                    disabled={controlsDisabled}
                    loading={pendingTuning("depegStepBps")}
                    onChange={(next) => setCoin({ depegStepBps: next === DEFAULT_VALUE ? null : Number(next) as 100 | 250 | 500 })}
                  />
                ) : null}
                {on && type === "safety" && subscription ? (
                  <SelectRow
                    inset
                    id={`coin-${coinId}-safety`}
                    title="Changes"
                    value={toSelectValue(subscription.safetyMode === "all" ? null : subscription.safetyMode)}
                    options={selectOptions(SAFETY_MODE_OPTIONS)}
                    disabled={controlsDisabled}
                    loading={pendingTuning("safetyMode")}
                    onChange={(next) => setCoin({ safetyMode: next === DEFAULT_VALUE ? null : next as "downgrade-only" | "upgrade-only" })}
                  />
                ) : null}
              </Fragment>
            );
          })}
        </ListSection>
      ) : null}

      <ListSection className={tracked ? undefined : "mt-5"}>
        {tracked && subscription ? (
          coinSnoozed && coinSnoozeUntil != null ? (
            <ListRow
              title={formatSnoozeUntil(coinSnoozeUntil, timezone, nowSec)}
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
        {tracked ? (
          <ListRow
            title="View on Pharos"
            trailing={<ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
            disabled={!webApp}
            onClick={() => webApp?.openLink?.(`${PHAROS_COIN_PAGE_PREFIX}${coinId}`)}
          />
        ) : null}
        {tracked ? (
          <ListRow
            title="Explain in chat"
            subtitle="Status, peg and Safety Score from the bot"
            trailing={<MessageCircle className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
            disabled={!webApp}
            onClick={() => openBot(`${TELEGRAM_BOT_URL}?start=${formatWhyPayload(coinId)}`)}
          />
        ) : null}
        {subscription && canEdit ? (
          <ListRow
            title={`Remove ${symbol} from my coins`}
            tone="destructive"
            disabled={busy}
            loading={pendingOperation?.kind === "remove-coin" && pendingOperation.stablecoinId === coinId}
            onClick={() => onRemove(subscription)}
          />
        ) : null}
        {!tracked && !subscription ? (
          <ListRow title="Nothing to change" subtitle="This coin is not in the current list." />
        ) : null}
      </ListSection>
    </>
  );
}
