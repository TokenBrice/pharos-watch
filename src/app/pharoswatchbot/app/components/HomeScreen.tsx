"use client";

import { useMemo } from "react";
import { Plus, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { isPausedSentinel, isTelegramBlockedFailureClass, isTelegramSnoozeActive } from "@shared/lib/telegram-delivery-policy";
import {
  ALERT_SHORT_LABELS,
  LIVE_ALERT_TYPES,
  PRESET_ALERT_TYPES,
  SNOOZE_DURATION_LABELS,
  SNOOZE_DURATION_TOKENS,
  presetLabel,
} from "../constants";
import {
  ALL_STABLECOINS_LABEL,
  coinCoverage,
  formatClock,
  formatQuietHoursRange,
  formatSnoozeUntil,
  formatTimeZoneCity,
  hasAnyCoverage,
  joinLabels,
} from "../format";
import type { MiniAppScreen } from "../use-mini-app-view";
import type { MiniAppScreenProps, SubscribedCoin, TelegramMiniAppState } from "../types";
import { ChoiceChips, ListRow, ListSection } from "./List";

type StripTone = "positive" | "neutral" | "warn" | "danger";

function statusStrip(state: TelegramMiniAppState, nowSec: number): { tone: StripTone; title: string; subtitle: string | null } {
  const failure = state.health.recentFailureClass;
  if (isTelegramBlockedFailureClass(failure)) {
    return {
      tone: "danger",
      title: "Telegram stopped delivering alerts",
      subtitle: "Send any message to PharosWatchBot to turn delivery back on.",
    };
  }
  const snoozeUntil = state.subscriber.snoozeUntilTs;
  if (snoozeUntil != null && isTelegramSnoozeActive(snoozeUntil, nowSec)) {
    return {
      tone: "warn",
      title: isPausedSentinel(snoozeUntil) ? "Alerts paused" : "Alerts snoozed",
      subtitle: isPausedSentinel(snoozeUntil) ? "Until you resume them" : `Until ${formatClock(snoozeUntil, state.subscriber.quietHours.timezone, nowSec)}`,
    };
  }
  if (!hasAnyCoverage(state)) {
    return { tone: "neutral", title: "No alerts on", subtitle: "Follow a preset or add coins below." };
  }
  const coinCount = state.subscriptions.length;
  const quiet = state.subscriber.quietHours;
  const parts = [
    state.presets.length > 0 ? state.presets.map((preset) => presetLabel(preset.id, preset.label)).join(", ") : null,
    coinCount > 0 ? `${coinCount} ${coinCount === 1 ? "coin" : "coins"}` : null,
    quiet.enabled ? `Quiet ${formatQuietHoursRange(quiet.startHourUtc, quiet.endHourUtc)}` : null,
  ].filter((part): part is string => part != null);
  return {
    tone: failure ? "warn" : "positive",
    // Only the blocked classes name a recovery path; any other class may be
    // permanent, so the strip never promises a retry it cannot verify.
    title: failure ? "Last delivery failed" : "Alerts on",
    subtitle: failure ? null : parts.join(" · ") || null,
  };
}

const STRIP_DOT: Record<StripTone, string> = {
  positive: "bg-state-positive-solid",
  neutral: "bg-muted-foreground/50",
  warn: "bg-state-warn-solid",
  danger: "bg-state-danger-solid",
};

/** Ranked like the catalog (largest first); coins missing from the catalog go last. */
export function sortCoinsByRank<T extends { stablecoinId: string; symbol: string }>(
  coins: readonly T[],
  rankById: ReadonlyMap<string, number>,
): T[] {
  return [...coins].sort((left, right) =>
    (rankById.get(left.stablecoinId) ?? Number.MAX_SAFE_INTEGER) - (rankById.get(right.stablecoinId) ?? Number.MAX_SAFE_INTEGER)
    || left.symbol.localeCompare(right.symbol));
}

/**
 * "DEWS · Depeg", "Depeg via USD Top 25", "DEWS · Depeg muted". A family whose
 * preset membership can't be read is named as such, never folded into "No alerts".
 */
export function coinSummary(coin: SubscribedCoin, state: TelegramMiniAppState): string {
  const coverage = coinCoverage(coin.stablecoinId, coin, state);
  const of = (kind: string) => LIVE_ALERT_TYPES.filter((type) => coverage[type].kind === kind);
  const active = LIVE_ALERT_TYPES.filter((type) => coverage[type].kind === "on" || coverage[type].kind === "via");
  const muted = of("muted");
  const unknown = of("unknown");
  const sources = new Set(active.map((type) => {
    const entry = coverage[type];
    return entry.kind === "via" ? entry.source : null;
  }));
  const activeText = joinLabels(active.map((type) => ALERT_SHORT_LABELS[type]));
  const viaSource = sources.size === 1 ? [...sources][0] : null;
  const names = (types: readonly string[]) => types.map((type) => ALERT_SHORT_LABELS[type as keyof typeof ALERT_SHORT_LABELS]).join(" · ");
  const parts = [
    activeText ? `${activeText}${viaSource ? ` via ${viaSource}` : ""}` : null,
    muted.length > 0 ? `${names(muted)} muted` : null,
    unknown.length > 0 ? `${names(unknown)} can't be checked` : null,
  ].filter((part): part is string => part != null);
  return parts.join(" · ") || "No alerts";
}

function familySummary<T extends keyof typeof ALERT_SHORT_LABELS>(flags: Record<T, boolean>, types: readonly T[]): string {
  const enabled = types.filter((type) => flags[type]);
  if (enabled.length > 3 && enabled.length === types.length) return "All alerts";
  return joinLabels(enabled.map((type) => ALERT_SHORT_LABELS[type])) ?? "Off";
}

export interface HomeScreenProps extends MiniAppScreenProps {
  push: (screen: MiniAppScreen) => void;
  onPause: () => void;
  /** Inline Resume only where no Telegram MainButton can carry it. */
  showInlineResume: boolean;
}

export function HomeScreen({ state, nowSec, canEdit, busy, pendingOperation, onMutate, push, onPause, showInlineResume }: HomeScreenProps) {
  const strip = statusStrip(state, nowSec);
  const rankById = useMemo(
    () => new Map(state.catalog.searchableCoins.map((coin) => [coin.stablecoinId, coin.rank ?? Number.MAX_SAFE_INTEGER])),
    [state.catalog.searchableCoins],
  );
  const coins = useMemo(() => sortCoinsByRank(state.subscriptions, rankById), [rankById, state.subscriptions]);
  const snoozeUntil = state.subscriber.snoozeUntilTs;
  const snoozed = snoozeUntil != null && isTelegramSnoozeActive(snoozeUntil, nowSec);
  const quiet = state.subscriber.quietHours;
  const timezone = state.subscriber.quietHours.timezone;
  const allPresetsFollowed = state.catalog.recommendedPresets.every((preset) => state.presets.some((followed) => followed.id === preset.id));
  const controlsDisabled = !canEdit || busy;

  return (
    <>
      <section className="flex items-start gap-3 rounded-xl bg-[var(--mini-card)] px-4 py-3" aria-label="Alert status">
        <span aria-hidden="true" className={cn("mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full", STRIP_DOT[strip.tone])} />
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold text-foreground">{strip.title}</h1>
          {strip.subtitle ? <p className="mt-0.5 text-sm text-muted-foreground">{strip.subtitle}</p> : null}
        </div>
        {snoozed && showInlineResume ? (
          <ChoiceChips
            label="Resume alerts"
            options={[{ value: "resume", label: "Resume" }]}
            disabled={controlsDisabled}
            pendingValue={pendingOperation?.kind === "clear-snooze" ? "resume" : null}
            onSelect={() => onMutate({ kind: "clear-snooze" })}
          />
        ) : null}
      </section>

      <ListSection title="Coverage">
        {state.presets.map((preset) => (
          <ListRow
            key={preset.id}
            title={presetLabel(preset.id, preset.label)}
            value={familySummary(preset.alertTypes, PRESET_ALERT_TYPES)}
            chevron
            onClick={() => push({ name: "group", groupId: preset.id })}
          />
        ))}
        <ListRow
          title={ALL_STABLECOINS_LABEL}
          value={familySummary(state.subscriber.globalAlerts, LIVE_ALERT_TYPES)}
          chevron
          onClick={() => push({ name: "group", groupId: "all" })}
        />
        {!allPresetsFollowed && canEdit ? (
          <ListRow
            title="Follow a preset"
            tone="accent"
            leading={<Plus className="h-4 w-4 text-[color:var(--telegram-link,var(--mini-accent))]" aria-hidden="true" />}
            onClick={() => push({ name: "add-group" })}
          />
        ) : null}
      </ListSection>

      <ListSection title="Your coins" trailing={coins.length > 0 ? <span className="pharos-numeric text-xs text-muted-foreground">{coins.length}</span> : null}>
        {canEdit ? (
          <ListRow
            title="Add coins"
            tone="accent"
            leading={<Search className="h-4 w-4 text-[color:var(--telegram-link,var(--mini-accent))]" aria-hidden="true" />}
            onClick={() => push({ name: "add-coins" })}
          />
        ) : null}
        {coins.map((coin) => {
          const coinSnoozed = coin.snoozeUntilTs != null && coin.snoozeUntilTs > nowSec;
          return (
            <ListRow
              key={coin.stablecoinId}
              ariaLabel={`${coin.symbol}, ${coinSummary(coin, state)}`}
              title={<><span className="font-medium">{coin.symbol}</span> <span className="text-muted-foreground">{coin.name !== coin.symbol ? coin.name : ""}</span></>}
              subtitle={coinSnoozed && coin.snoozeUntilTs != null
                ? formatSnoozeUntil(coin.snoozeUntilTs, timezone, nowSec)
                : coinSummary(coin, state)}
              chevron
              className="min-h-[3.25rem]"
              onClick={() => push({ name: "coin", coinId: coin.stablecoinId })}
            />
          );
        })}
        {coins.length === 0 ? (
          <ListRow title="No coins yet" subtitle="Add the coins you hold or watch." />
        ) : null}
      </ListSection>

      <ListSection title="Make it quieter">
        {snoozed ? null : (
          <>
            <ListRow
              title="Snooze all"
              trailing={(
                <ChoiceChips
                  label="Snooze all alerts"
                  options={SNOOZE_DURATION_TOKENS.map((token) => ({ value: token, label: token, ariaLabel: `Snooze all alerts for ${SNOOZE_DURATION_LABELS[token]}` }))}
                  disabled={controlsDisabled}
                  pendingValue={pendingOperation?.kind === "set-snooze" ? pendingOperation.durationToken : null}
                  onSelect={(token) => onMutate({ kind: "set-snooze", durationToken: token })}
                />
              )}
            />
            <ListRow
              title="Pause until I resume"
              disabled={controlsDisabled}
              loading={pendingOperation?.kind === "pause"}
              onClick={onPause}
            />
          </>
        )}
        <ListRow
          title="Quiet hours"
          value={quiet.enabled ? `${formatQuietHoursRange(quiet.startHourUtc, quiet.endHourUtc)} ${formatTimeZoneCity(quiet.timezone)}` : "Off"}
          chevron
          onClick={() => push({ name: "settings" })}
        />
      </ListSection>

      <ListSection>
        <ListRow title="Settings" chevron onClick={() => push({ name: "settings" })} />
      </ListSection>
    </>
  );
}
