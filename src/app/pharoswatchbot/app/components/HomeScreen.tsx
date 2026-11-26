"use client";

import { useMemo } from "react";
import { ChevronRight, Plus, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { isPausedSentinel, isTelegramBlockedFailureClass, isTelegramSnoozeActive } from "@shared/lib/telegram-delivery-policy";
import {
  ALERT_SHORT_LABELS,
  LIVE_ALERT_TYPES,
  PRESET_ALERT_TYPES,
  presetLabel,
} from "../constants";
import {
  ALL_STABLECOINS_LABEL,
  coinCoverage,
  displayCoinName,
  formatClock,
  formatHour,
  formatOffPegRowValue,
  formatSnoozeUntil,
  hasAnyCoverage,
  hasOwnEnabledFamily,
  isQuietHoursActiveNow,
  joinLabels,
} from "../format";
import { canUseTelegramPopup, type TelegramWebAppSdk } from "../telegram-sdk";
import type { HomePegContext } from "../use-mini-app-context";
import type { MiniAppScreen } from "../use-mini-app-view";
import type {
  MiniAppPrimaryActionKind,
  MiniAppScreenProps,
  SubscribedCoin,
  TelegramMiniAppActiveDepeg,
  TelegramMiniAppState,
} from "../types";
import { ChoiceChips, ListRow, ListSection } from "./List";

type StripTone = "positive" | "neutral" | "warn" | "danger";

const COLLAPSED_COIN_LIMIT = 8;
const OFF_PEG_ROW_LIMIT = 3;

function statusStrip(
  state: TelegramMiniAppState,
  nowSec: number,
  ownCount: number,
  hasAnyGlobal: boolean,
  activeDepegs: readonly TelegramMiniAppActiveDepeg[],
  symbolById: ReadonlyMap<string, string>,
  truncated: boolean,
): {
  tone: StripTone;
  title: string;
  subtitle: string | null;
  tappableToSettings?: boolean;
} {
  const failure = state.health.recentFailureClass;
  if (isTelegramBlockedFailureClass(failure)) {
    return {
      tone: "danger",
      title: "Telegram stopped delivering alerts",
      subtitle: "Open the chat and tap Start (or send /status) to resume delivery.",
    };
  }
  const snoozeUntil = state.subscriber.snoozeUntilTs;
  const snoozed = snoozeUntil != null && isTelegramSnoozeActive(snoozeUntil, nowSec);
  const covered = hasAnyCoverage(state);
  const quiet = state.subscriber.quietHours;
  const quietPart = isQuietHoursActiveNow(quiet, nowSec)
    ? `Quiet until ${formatHour(quiet.endHourUtc)}`
    : null;
  const presetPart = state.presets.length > 0
    ? state.presets.length <= 2
      ? state.presets.map((preset) => presetLabel(preset.id, preset.label)).join(", ")
      : `${state.presets.length} presets`
    : null;
  const baseParts = [
    hasAnyGlobal ? ALL_STABLECOINS_LABEL : null,
    presetPart,
    ownCount > 0 ? `${ownCount} ${ownCount === 1 ? "coin" : "coins"}` : null,
  ].filter((part): part is string => part != null);

  if (activeDepegs.length > 0 && covered) {
    const first = activeDepegs[0]!;
    const firstSymbol = symbolById.get(first.stablecoinId) ?? first.stablecoinId;
    const alertStatusPart = snoozed && snoozeUntil != null
      ? isPausedSentinel(snoozeUntil)
        ? "Alerts paused"
        : `Alerts paused until ${formatClock(snoozeUntil, quiet.timezone, nowSec)}`
      : failure
        ? "Last delivery failed"
        : "Alerts on";
    const summaryParts = [alertStatusPart, ...baseParts];
    const parts = quietPart
      ? [...summaryParts.slice(0, 2), quietPart]
      : summaryParts.slice(0, 3);
    return {
      tone: "danger",
      title: activeDepegs.length === 1
        ? `${firstSymbol} is off its peg`
        : truncated
          ? `${activeDepegs.length}+ watched coins off peg`
          : `${activeDepegs.length} coins are off their peg`,
      subtitle: parts.join(" · "),
      tappableToSettings: Boolean(failure && !snoozed),
    };
  }

  if (snoozed && snoozeUntil != null) {
    return {
      tone: "warn",
      title: "Alerts paused",
      subtitle: isPausedSentinel(snoozeUntil)
        ? "Until you resume them"
        : `Until ${formatClock(snoozeUntil, quiet.timezone, nowSec)}`,
    };
  }
  if (!covered) {
    return { tone: "neutral", title: "No alerts on", subtitle: "Follow a preset or add coins below." };
  }
  if (failure) {
    return {
      tone: "warn",
      // Only the blocked classes name a recovery path; any other class may be
      // permanent, so the strip never promises a retry it cannot verify.
      title: "Last delivery failed",
      subtitle: "Open delivery status in Settings",
      tappableToSettings: true,
    };
  }
  const parts = quietPart
    ? [...baseParts.slice(0, 2), quietPart]
    : baseParts.slice(0, 3);
  return {
    tone: "positive",
    title: "Alerts on",
    subtitle: parts.join(" · ") || null,
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
 * "DEWS · Depeg", "Depeg via USD Top 25", "DEWS · Depeg off". A family whose
 * preset membership can't be read is named as such, never folded into "No alerts".
 */
export function coinSummary(
  coin: SubscribedCoin,
  state: TelegramMiniAppState,
  presetMemberSetById?: ReadonlyMap<string, ReadonlySet<string>>,
): string {
  const coverage = coinCoverage(coin.stablecoinId, coin, state, presetMemberSetById);
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
    muted.length > 0 ? `${names(muted)} off` : null,
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
  webApp: TelegramWebAppSdk | null;
  primaryActionKind: MiniAppPrimaryActionKind | null;
  hasMainButton: boolean;
  coinsExpanded: boolean;
  onExpandCoins: () => void;
  homePegContext?: HomePegContext;
}

export function HomeScreen({
  state,
  nowSec,
  canEdit,
  busy,
  pendingOperation,
  presetMemberSetById,
  onMutate,
  push,
  webApp,
  primaryActionKind,
  hasMainButton,
  coinsExpanded,
  onExpandCoins,
  homePegContext,
}: HomeScreenProps) {
  const rankById = useMemo(
    () => new Map(state.catalog.searchableCoins.map((coin) => [coin.stablecoinId, coin.rank ?? Number.MAX_SAFE_INTEGER])),
    [state.catalog.searchableCoins],
  );
  const symbolById = useMemo(() => {
    const map = new Map<string, string>();
    for (const coin of state.catalog.searchableCoins) map.set(coin.stablecoinId, coin.symbol);
    for (const coin of state.subscriptions) map.set(coin.stablecoinId, coin.symbol);
    return map;
  }, [state.catalog.searchableCoins, state.subscriptions]);
  const activeDepegs = useMemo(() => {
    if (homePegContext?.status !== "ok" || homePegContext.events.length === 0) return [];
    return [...homePegContext.events].sort((left, right) => {
      const leftMag = Math.abs(left.currentDeviationBps ?? left.peakDeviationBps);
      const rightMag = Math.abs(right.currentDeviationBps ?? right.peakDeviationBps);
      if (rightMag !== leftMag) return rightMag - leftMag;
      return (rankById.get(left.stablecoinId) ?? Number.MAX_SAFE_INTEGER)
        - (rankById.get(right.stablecoinId) ?? Number.MAX_SAFE_INTEGER)
        || (symbolById.get(left.stablecoinId) ?? left.stablecoinId).localeCompare(symbolById.get(right.stablecoinId) ?? right.stablecoinId);
    });
  }, [homePegContext, rankById, symbolById]);
  const offPegIds = useMemo(() => new Set(activeDepegs.map((event) => event.stablecoinId)), [activeDepegs]);
  // State-first sort: off-peg coins first, then actively snoozed coins, then market-cap order.
  const coins = useMemo(() => {
    const ranked = sortCoinsByRank(state.subscriptions, rankById);
    const priorityBucket = (coin: SubscribedCoin) => (
      offPegIds.has(coin.stablecoinId)
        ? 0
        : coin.snoozeUntilTs != null && coin.snoozeUntilTs > nowSec
          ? 1
          : 2
    );
    return ranked.sort((left, right) => priorityBucket(left) - priorityBucket(right));
  }, [nowSec, offPegIds, rankById, state.subscriptions]);
  const coinSummaryById = useMemo(() => {
    const summaries = new Map<string, string>();
    for (const coin of state.subscriptions) {
      summaries.set(coin.stablecoinId, coinSummary(coin, state, presetMemberSetById));
    }
    return summaries;
  }, [presetMemberSetById, state]);
  const ownCount = useMemo(() => coins.filter(hasOwnEnabledFamily).length, [coins]);
  const hasAnyGlobal = LIVE_ALERT_TYPES.some((type) => state.subscriber.globalAlerts[type]);
  const truncated = Boolean(homePegContext?.truncated);
  const strip = statusStrip(state, nowSec, ownCount, hasAnyGlobal, activeDepegs, symbolById, truncated);
  const snoozeUntil = state.subscriber.snoozeUntilTs;
  const snoozed = snoozeUntil != null && isTelegramSnoozeActive(snoozeUntil, nowSec);
  const isBlocked = isTelegramBlockedFailureClass(state.health.recentFailureClass);
  const timezone = state.subscriber.quietHours.timezone;
  const allPresetsFollowed = state.catalog.recommendedPresets.every((preset) => state.presets.some((followed) => followed.id === preset.id));
  const controlsDisabled = !canEdit || busy;
  const showInlineResume = snoozed && (!hasMainButton || primaryActionKind !== "resume");
  const showInlinePause = !snoozed && !isBlocked && !strip.tappableToSettings && hasAnyCoverage(state) && canEdit;
  const pausePending = pendingOperation?.kind === "set-snooze" || pendingOperation?.kind === "pause";
  const visibleCoins = coinsExpanded || coins.length <= COLLAPSED_COIN_LIMIT ? coins : coins.slice(0, COLLAPSED_COIN_LIMIT);

  const handlePauseChip = () => {
    if (canUseTelegramPopup(webApp)) {
      webApp!.showPopup!(
        {
          title: "Pause alerts",
          message: "Stop all alerts temporarily.",
          buttons: [
            { id: "4h", type: "default", text: "4 hours" },
            { id: "24h", type: "default", text: "24 hours" },
            { id: "pause", type: "default", text: "Until I resume" },
          ],
        },
        (buttonId) => {
          if (buttonId === "4h" || buttonId === "24h") {
            onMutate({ kind: "set-snooze", durationToken: buttonId });
          } else if (buttonId === "pause") {
            onMutate({ kind: "pause" });
          }
        },
      );
      return;
    }
    push({ name: "settings" });
  };

  const presetsSection = state.presets.length > 0 || hasAnyGlobal || (!allPresetsFollowed && canEdit) ? (
    <ListSection title="Presets">
      {state.presets.map((preset) => (
        <ListRow
          key={preset.id}
          title={presetLabel(preset.id, preset.label)}
          value={familySummary(preset.alertTypes, PRESET_ALERT_TYPES)}
          chevron
          onClick={() => push({ name: "group", groupId: preset.id })}
        />
      ))}
      {hasAnyGlobal ? (
        <ListRow
          title={ALL_STABLECOINS_LABEL}
          value={familySummary(state.subscriber.globalAlerts, LIVE_ALERT_TYPES)}
          chevron
          onClick={() => push({ name: "group", groupId: "all" })}
        />
      ) : null}
      {!allPresetsFollowed && canEdit ? (
        <ListRow
          title="Follow a preset"
          tone="accent"
          leading={<Plus className="h-4 w-4 text-[color:var(--telegram-link,var(--mini-accent))]" aria-hidden="true" />}
          onClick={() => push({ name: "add-group" })}
        />
      ) : null}
    </ListSection>
  ) : null;

  const renderEmptyCoinsRow = () => {
    if (state.presets.length === 1) {
      const preset = state.presets[0]!;
      const label = presetLabel(preset.id, preset.label);
      const count = preset.memberIds?.length ?? null;
      return (
        <ListRow
          title={count != null ? `${label} covers ${count} ${count === 1 ? "coin" : "coins"}` : `${label} is active`}
          subtitle="Add any others you hold"
        />
      );
    }
    if (state.presets.length > 1) {
      const allKnown = state.presets.every((preset) => preset.memberIds != null);
      const count = allKnown ? new Set(state.presets.flatMap((preset) => preset.memberIds ?? [])).size : null;
      return (
        <ListRow
          title={count != null ? `Your presets cover ${count} ${count === 1 ? "coin" : "coins"}` : `${state.presets.length} presets active`}
          subtitle="Add any others you hold"
        />
      );
    }
    if (hasAnyGlobal) {
      return <ListRow title="All stablecoins is on" subtitle="Add a coin to customize its alerts" />;
    }
    return <ListRow title="No coins yet" subtitle="Add the coins you hold or watch." />;
  };

  const coinsSection = (
    <ListSection
      title="Your coins"
      trailing={ownCount > 0 ? <span className="pharos-numeric text-xs text-muted-foreground">{ownCount}</span> : null}
    >
      {canEdit ? (
        <ListRow
          title="Add coins"
          tone="accent"
          leading={<Search className="h-4 w-4 text-[color:var(--telegram-link,var(--mini-accent))]" aria-hidden="true" />}
          onClick={() => push({ name: "add-coins" })}
        />
      ) : null}
      {visibleCoins.map((coin) => {
        const coinSnoozed = coin.snoozeUntilTs != null && coin.snoozeUntilTs > nowSec;
        const summary = coinSnoozed && coin.snoozeUntilTs != null
          ? formatSnoozeUntil(coin.snoozeUntilTs, timezone, nowSec)
          : (coinSummaryById.get(coin.stablecoinId) ?? coinSummary(coin, state, presetMemberSetById));
        const secondaryName = displayCoinName(coin.symbol, coin.name);
        return (
          <ListRow
            key={coin.stablecoinId}
            ariaLabel={secondaryName ? `${coin.symbol}, ${secondaryName}, ${summary}` : `${coin.symbol}, ${summary}`}
            title={(
              <>
                <span className="font-medium">{coin.symbol}</span>
                {secondaryName ? <> <span className="text-muted-foreground">{secondaryName}</span></> : null}
              </>
            )}
            subtitle={coinSnoozed ? <span className="tabular-nums">{summary}</span> : summary}
            chevron
            className="min-h-[3.25rem]"
            onClick={() => push({ name: "coin", coinId: coin.stablecoinId })}
          />
        );
      })}
      {!coinsExpanded && coins.length > COLLAPSED_COIN_LIMIT ? (
        <ListRow
          title={`Show all ${coins.length} coins`}
          tone="accent"
          onClick={onExpandCoins}
        />
      ) : null}
      {coins.length === 0 ? renderEmptyCoinsRow() : null}
    </ListSection>
  );

  const coinsFirst = state.presets.length === 0 && !hasAnyGlobal;

  return (
    <>
      <section className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-[var(--mini-card)] px-4 py-3" aria-label="Alert status">
        <span aria-hidden="true" className={cn("h-2.5 w-2.5 shrink-0 self-start mt-1.5 rounded-full", STRIP_DOT[strip.tone])} />
        <div className="min-w-[9rem] flex-1">
          <h1 tabIndex={-1} className="outline-none text-base font-semibold text-foreground">{strip.title}</h1>
          {strip.subtitle ? <p className="mt-0.5 text-sm tabular-nums text-muted-foreground">{strip.subtitle}</p> : null}
        </div>
        {strip.tappableToSettings ? (
          <button
            type="button"
            aria-label="Open delivery status in Settings"
            onClick={() => push({ name: "settings" })}
            className="-my-1 -mr-2 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground/70 transition-colors active:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : showInlineResume ? (
          <ChoiceChips
            label="Resume alerts"
            options={[{ value: "resume", label: "Resume" }]}
            disabled={controlsDisabled}
            pendingValue={pendingOperation?.kind === "clear-snooze" ? "resume" : null}
            onSelect={() => onMutate({ kind: "clear-snooze" })}
          />
        ) : showInlinePause ? (
          <ChoiceChips
            label="Pause alerts"
            options={[{ value: "pause", label: "Pause" }]}
            disabled={controlsDisabled}
            pendingValue={pausePending ? "pause" : null}
            onSelect={handlePauseChip}
          />
        ) : null}
      </section>

      {homePegContext?.status === "unavailable" ? (
        <p className="mt-2 px-1 text-xs text-muted-foreground">Live peg status unavailable.</p>
      ) : null}

      {activeDepegs.length > 0 ? (
        <ListSection
          title="Off peg now"
          footer={truncated ? "Checked top 20 watched coins by market cap." : undefined}
        >
          {activeDepegs.slice(0, OFF_PEG_ROW_LIMIT).map((event) => {
            const sym = symbolById.get(event.stablecoinId) ?? event.stablecoinId;
            const detail = formatOffPegRowValue(event);
            return (
              <ListRow
                key={event.stablecoinId}
                ariaLabel={`${sym}, ${detail}`}
                title={<span className="font-medium">{sym}</span>}
                value={<span className="tabular-nums">{detail}</span>}
                chevron
                onClick={() => push({ name: "coin", coinId: event.stablecoinId })}
              />
            );
          })}
        </ListSection>
      ) : null}

      {coinsFirst ? (
        <>
          {coinsSection}
          {presetsSection}
        </>
      ) : (
        <>
          {presetsSection}
          {coinsSection}
        </>
      )}

      <ListSection>
        <ListRow title="Settings" chevron onClick={() => push({ name: "settings" })} />
      </ListSection>
    </>
  );
}
