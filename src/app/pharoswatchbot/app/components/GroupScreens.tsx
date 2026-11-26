"use client";

import { Fragment, useCallback, useMemo, useState } from "react";
import { Check } from "lucide-react";
import { TELEGRAM_PRESET_DEFINITIONS, type TelegramPresetId } from "@shared/lib/telegram-presets";
import {
  ALERT_DESCRIPTIONS,
  ALERT_LABELS,
  DEPEG_STEP_OPTIONS,
  GLOBAL_ALERT_DESCRIPTIONS,
  LIVE_ALERT_TYPES,
  PRESET_ALERT_TYPES,
  depegStepSubtitle,
  presetCategory,
  presetDescription,
  presetLabel,
  type PresetAlertType,
} from "../constants";
import { ALL_STABLECOINS_LABEL, displayCoinName, formatPresetSummaryLine } from "../format";
import { usePrimaryAction } from "../primary-action";
import type { TelegramWebAppSdk } from "../telegram-sdk";
import type { PresetsLiveContext } from "../use-mini-app-context";
import type { MiniAppScreen } from "../use-mini-app-view";
import type { FollowedPreset, MiniAppScreenProps, TelegramAlertType, TelegramDepegStepBps, TelegramMiniAppState } from "../types";
import { sortCoinsByRank } from "./HomeScreen";
import { ListRow, ListSection, SelectRow, Switch } from "./List";

const DEFAULT_VALUE = "default";
const COLLAPSED_MEMBER_LIMIT = 8;
const GLOBAL_DAILY_FAMILIES = ["dews", "safety"] as const satisfies readonly TelegramAlertType[];
const GLOBAL_LIVE_FAMILIES = ["depeg", "reserve", "freeze"] as const satisfies readonly TelegramAlertType[];

const DEPEG_SELECT_OPTIONS = DEPEG_STEP_OPTIONS.map((option) => ({
  value: option.value == null ? DEFAULT_VALUE : String(option.value),
  label: option.label,
}));
function parseDepegStep(value: string): TelegramDepegStepBps | null {
  return value === DEFAULT_VALUE ? null : Number(value) as TelegramDepegStepBps;
}

interface PresetShape {
  id: string;
  category: string;
  kind: string;
  pegCurrency?: string;
  excludePegCurrency?: string;
  topN?: number;
  minMarketCapUsd?: number;
}
const DEFINITION_BY_ID = new Map<string, PresetShape>(
  TELEGRAM_PRESET_DEFINITIONS.map((definition) => [definition.id, definition as PresetShape]),
);

/** A followed preset that is a strict superset (larger peg-top N or lower market-cap floor) already covers this one. */
export function coveringPreset(presetId: string, followed: readonly FollowedPreset[]): FollowedPreset | null {
  const definition = DEFINITION_BY_ID.get(presetId);
  if (!definition) return null;
  return followed.find((candidate) => {
    const other = DEFINITION_BY_ID.get(candidate.id);
    if (!other || other.id === definition.id || other.kind !== definition.kind) return false;
    if (definition.kind === "peg-top") {
      return other.pegCurrency === definition.pegCurrency
        && other.excludePegCurrency === definition.excludePegCurrency
        && (other.topN ?? 0) >= (definition.topN ?? 0);
    }
    if (definition.kind === "market-cap") {
      return (other.minMarketCapUsd ?? Number.POSITIVE_INFINITY) <= (definition.minMarketCapUsd ?? 0);
    }
    return false;
  }) ?? null;
}

function AllStablecoinsScreen({
  state,
  canEdit,
  busy,
  pendingOperation,
  onMutate,
  webApp,
}: MiniAppScreenProps & { webApp: TelegramWebAppSdk | null }) {
  const global = state.subscriber.globalAlerts;
  const controlsDisabled = !canEdit || busy;

  const handleGlobalDepegStepChange = useCallback((next: string) => {
    onMutate({ kind: "set-global-depeg-step", depegStepBps: parseDepegStep(next) });
  }, [onMutate]);

  const toggleGlobal = (type: TelegramAlertType, next: boolean) => {
    if (type === "depeg" && next && webApp?.showConfirm) {
      webApp.showConfirm("Send depeg alerts for every tracked coin?", (confirmed) => {
        if (confirmed) onMutate({ kind: "set-global", alertType: "depeg", enabled: true });
      });
      return;
    }
    onMutate({ kind: "set-global", alertType: type, enabled: next });
  };

  const renderFamilyRow = (type: TelegramAlertType) => (
    <Fragment key={type}>
      <ListRow
        title={ALERT_LABELS[type]}
        subtitle={GLOBAL_ALERT_DESCRIPTIONS[type]}
        className="min-h-[3.25rem]"
        trailing={(
          <Switch
            label={`All stablecoins ${ALERT_LABELS[type]}`}
            description={GLOBAL_ALERT_DESCRIPTIONS[type]}
            checked={Boolean(global[type])}
            disabled={controlsDisabled}
            loading={pendingOperation?.kind === "set-global" && pendingOperation.alertType === type}
            onChange={(next) => toggleGlobal(type, next)}
          />
        )}
      />
      {type === "depeg" && global.depeg ? (
        <SelectRow
          inset
          id="global-depeg-step"
          title="Alert at"
          subtitle={depegStepSubtitle(global.depegStepBps, "a coin")}
          value={global.depegStepBps == null ? DEFAULT_VALUE : String(global.depegStepBps)}
          options={DEPEG_SELECT_OPTIONS}
          disabled={controlsDisabled}
          loading={pendingOperation?.kind === "set-global-depeg-step"}
          onChange={handleGlobalDepegStepChange}
        />
      ) : null}
    </Fragment>
  );

  return (
    <>
      <header className="px-1 pt-2">
        <h1 tabIndex={-1} className="outline-none text-2xl font-semibold tracking-tight text-foreground">
          {ALL_STABLECOINS_LABEL}
        </h1>
        <p className="mt-1 text-sm text-pretty text-muted-foreground">
          Every active stablecoin Pharos tracks, including ones you don&apos;t follow.
        </p>
      </header>
      <ListSection title="Daily summary only" className="mt-5">
        {GLOBAL_DAILY_FAMILIES.map(renderFamilyRow)}
      </ListSection>
      <ListSection title="Live">
        {GLOBAL_LIVE_FAMILIES.map(renderFamilyRow)}
      </ListSection>
    </>
  );
}

function PresetScreen({
  state,
  canEdit,
  busy,
  rateLimited = false,
  pendingOperation,
  queuedOperation = null,
  getIntendedPresetValue,
  onMutate,
  presetId,
  onUnfollow,
  push,
  membersExpanded,
  onExpandMembers,
}: MiniAppScreenProps & {
  presetId: TelegramPresetId;
  onUnfollow: (preset: FollowedPreset) => void;
  push: (screen: MiniAppScreen) => void;
  membersExpanded: boolean;
  onExpandMembers: () => void;
}) {
  const followed = state.presets.find((preset) => preset.id === presetId) ?? null;
  const catalogPreset = state.catalog.recommendedPresets.find((preset) => preset.id === presetId);
  const label = presetLabel(presetId, followed?.label ?? catalogPreset?.label);
  const description = presetDescription(presetId, followed?.description ?? catalogPreset?.description);
  const [draft, setDraft] = useState<Record<PresetAlertType, boolean>>({ dews: true, depeg: true, safety: false });
  const pendingFollow = pendingOperation?.kind === "follow-preset" && pendingOperation.presetId === presetId ? pendingOperation : null;
  const queuedFollow = queuedOperation?.kind === "follow-preset" && queuedOperation.presetId === presetId ? queuedOperation : null;
  const pending = pendingFollow != null;
  const canCoalesceThisPreset = followed != null && !rateLimited && pendingFollow != null;
  const presetControlsDisabled = !canEdit || rateLimited || (busy && !canCoalesceThisPreset);
  const flags = followed ? followed.alertTypes : draft;
  const intendedFlags: Record<PresetAlertType, boolean> = followed && getIntendedPresetValue
    ? {
        dews: getIntendedPresetValue(presetId, "dews", Boolean(flags.dews)),
        depeg: getIntendedPresetValue(presetId, "depeg", Boolean(flags.depeg)),
        safety: getIntendedPresetValue(presetId, "safety", Boolean(flags.safety)),
      }
    : { dews: Boolean(flags.dews), depeg: Boolean(flags.depeg), safety: Boolean(flags.safety) };
  const enabledCount = PRESET_ALERT_TYPES.filter((type) => intendedFlags[type]).length;
  const covering = followed ? null : coveringPreset(presetId, state.presets);

  const catalogIndex = useMemo(() => ({
    byId: new Map(state.catalog.searchableCoins.map((coin) => [coin.stablecoinId, coin])),
    rankById: new Map(state.catalog.searchableCoins.map((coin) => [coin.stablecoinId, coin.rank ?? Number.MAX_SAFE_INTEGER])),
  }), [state.catalog.searchableCoins]);
  const memberCoins = followed?.memberIds
    ? sortCoinsByRank(
      followed.memberIds.map((id) => {
        const entry = catalogIndex.byId.get(id);
        return {
          stablecoinId: id,
          symbol: entry?.symbol ?? id,
          name: entry?.name ?? id,
        };
      }),
      catalogIndex.rankById,
    )
    : null;

  usePrimaryAction(canEdit && !followed ? {
    kind: "follow-preset",
    text: `Follow ${label}`,
    progress: pending,
    onClick: () => {
      if (!busy && enabledCount > 0) onMutate({ kind: "follow-preset", presetId, alertTypes: draft });
    },
  } : null);

  const change = (type: PresetAlertType, confirmedChecked: boolean) => {
    if (!followed) {
      setDraft((current) => ({ ...current, [type]: !confirmedChecked }));
      return;
    }
    const intended = getIntendedPresetValue ? getIntendedPresetValue(presetId, type, confirmedChecked) : confirmedChecked;
    const next = !intended;
    onMutate({
      kind: "follow-preset",
      presetId,
      alertTypes: { [type]: next },
      ...(type === "depeg" && !next ? { depegStepBps: null } : {}),
    });
  };

  const handlePresetDepegStepChange = useCallback((next: string) => {
    onMutate({ kind: "follow-preset", presetId, alertTypes: {}, depegStepBps: parseDepegStep(next) });
  }, [onMutate, presetId]);

  const alertsFooter = enabledCount === 1
    ? "Keep at least one alert on. Reserve drift and Freezes are set per coin."
    : "Reserve drift and Freezes are set per coin.";

  const visibleMembers = memberCoins == null
    ? null
    : membersExpanded || memberCoins.length <= COLLAPSED_MEMBER_LIMIT
      ? memberCoins
      : memberCoins.slice(0, COLLAPSED_MEMBER_LIMIT);

  return (
    <>
      <header className="px-1 pt-2">
        <h1 tabIndex={-1} className="outline-none text-2xl font-semibold tracking-tight text-foreground">{label}</h1>
        {description ? <p className="mt-1 text-sm text-pretty text-muted-foreground">{description}</p> : null}
        {!followed ? <p className="mt-1 text-sm text-muted-foreground">Members change as market caps move.</p> : null}
      </header>
      {covering ? (
        <p className="mt-4 rounded-xl bg-[var(--mini-card)] px-4 py-3 text-sm text-muted-foreground">
          You already follow {presetLabel(covering.id, covering.label)}, which includes these coins.
        </p>
      ) : null}
      <ListSection
        title={followed ? "Alerts" : "Alerts to follow"}
        className="mt-5"
        footer={alertsFooter}
      >
        {PRESET_ALERT_TYPES.map((type) => {
          const checked = Boolean(flags[type]);
          const intendedChecked = intendedFlags[type];
          return (
            <Fragment key={type}>
              <ListRow
                title={ALERT_LABELS[type]}
                subtitle={ALERT_DESCRIPTIONS[type]}
                className="min-h-[3.25rem]"
                trailing={(
                  <Switch
                    label={`${label} ${ALERT_LABELS[type]}`}
                    description={ALERT_DESCRIPTIONS[type]}
                    checked={checked}
                    disabled={presetControlsDisabled || (intendedChecked && enabledCount === 1)}
                    allowWhileLoading={canCoalesceThisPreset}
                    loading={followed != null && pendingFollow?.alertTypes[type] != null}
                    queued={followed != null && queuedFollow?.alertTypes[type] != null}
                    onChange={() => change(type, checked)}
                  />
                )}
              />
              {type === "depeg" && followed?.alertTypes.depeg ? (
                <SelectRow
                  inset
                  id={`preset-${presetId}-depeg-step`}
                  title="Alert at"
                  subtitle={depegStepSubtitle(followed.depegStepBps, "a coin")}
                  value={followed.depegStepBps == null ? DEFAULT_VALUE : String(followed.depegStepBps)}
                  options={DEPEG_SELECT_OPTIONS}
                  disabled={presetControlsDisabled}
                  allowWhileLoading={canCoalesceThisPreset}
                  loading={pendingFollow != null && "depegStepBps" in pendingFollow && pendingFollow.alertTypes.depeg !== false}
                  queued={queuedFollow != null && "depegStepBps" in queuedFollow && queuedFollow.alertTypes.depeg !== false}
                  onChange={handlePresetDepegStepChange}
                />
              ) : null}
            </Fragment>
          );
        })}
      </ListSection>

      {followed ? (
        <ListSection
          title="Current coins"
          trailing={memberCoins != null && memberCoins.length > 0 ? (
            <span className="pharos-numeric text-xs text-muted-foreground">{memberCoins.length}</span>
          ) : null}
        >
          {visibleMembers == null ? (
            <ListRow title="Current coins can't be loaded right now" />
          ) : visibleMembers.length === 0 ? (
            <ListRow title="No coins match right now" />
          ) : (
            <>
              {visibleMembers.map((coin) => {
                const secondaryName = displayCoinName(coin.symbol, coin.name);
                return (
                  <ListRow
                    key={coin.stablecoinId}
                    title={(
                      <>
                        <span className="font-medium">{coin.symbol}</span>
                        {secondaryName ? <> <span className="text-muted-foreground">{secondaryName}</span></> : null}
                      </>
                    )}
                    chevron
                    onClick={() => push({ name: "coin", coinId: coin.stablecoinId })}
                  />
                );
              })}
              {!membersExpanded && memberCoins != null && memberCoins.length > COLLAPSED_MEMBER_LIMIT ? (
                <ListRow
                  title={`Show all ${memberCoins.length} coins`}
                  tone="accent"
                  onClick={onExpandMembers}
                />
              ) : null}
            </>
          )}
        </ListSection>
      ) : null}

      {followed && canEdit ? (
        <ListSection>
          <ListRow
            title={`Unfollow ${label}`}
            tone="destructive"
            disabled={busy}
            loading={pendingOperation?.kind === "unfollow-preset" && pendingOperation.presetId === presetId}
            onClick={() => onUnfollow(followed)}
          />
        </ListSection>
      ) : null}
    </>
  );
}

export interface GroupScreenProps extends MiniAppScreenProps {
  groupId: TelegramPresetId | "all";
  webApp: TelegramWebAppSdk | null;
  push: (screen: MiniAppScreen) => void;
  onUnfollow: (preset: FollowedPreset) => void;
  membersExpanded: boolean;
  onExpandMembers: () => void;
}

export function GroupScreen({
  groupId,
  webApp,
  push,
  onUnfollow,
  membersExpanded,
  onExpandMembers,
  ...props
}: GroupScreenProps) {
  if (groupId === "all") return <AllStablecoinsScreen {...props} webApp={webApp} />;
  return (
    <PresetScreen
      {...props}
      presetId={groupId}
      onUnfollow={onUnfollow}
      push={push}
      membersExpanded={membersExpanded}
      onExpandMembers={onExpandMembers}
    />
  );
}

export function AddGroupScreen({
  state,
  push,
  presetsLiveContext,
}: {
  state: TelegramMiniAppState;
  push: (screen: MiniAppScreen) => void;
  presetsLiveContext?: PresetsLiveContext;
}) {
  const followedIds = new Set(state.presets.map((preset) => preset.id));
  const hasAnyGlobal = LIVE_ALERT_TYPES.some((type) => state.subscriber.globalAlerts[type]);
  const sections = ["By peg", "By size"] as const;
  return (
    <>
      <header className="px-1 pt-2">
        <h1 tabIndex={-1} className="outline-none text-2xl font-semibold tracking-tight text-foreground">
          Follow a preset
        </h1>
        <p className="mt-1 text-sm text-pretty text-muted-foreground">
          A preset follows a set of coins for you and updates as market caps move.
        </p>
      </header>
      {sections.map((section, index) => (
        <ListSection key={section} title={section} className={index === 0 ? "mt-5" : undefined}>
          {state.catalog.recommendedPresets
            .filter((preset) => presetCategory(preset.id) === section)
            .map((preset) => {
              const liveSummary = presetsLiveContext?.status === "ok"
                ? presetsLiveContext.byId.get(preset.id)
                : undefined;
              const subtitle = (liveSummary ? formatPresetSummaryLine(liveSummary) : null)
                ?? presetDescription(preset.id, preset.description)
                ?? undefined;
              return (
                <ListRow
                  key={preset.id}
                  title={presetLabel(preset.id, preset.label)}
                  subtitle={subtitle}
                  className="min-h-[3.25rem]"
                  trailing={followedIds.has(preset.id) ? (
                    <>
                      <span className="sr-only">Following</span>
                      <Check className="h-4 w-4 shrink-0 text-[color:var(--telegram-link,var(--mini-accent))]" aria-hidden="true" />
                    </>
                  ) : undefined}
                  chevron
                  onClick={() => push({ name: "group", groupId: preset.id })}
                />
              );
            })}
        </ListSection>
      ))}
      <ListSection title="Everything">
        <ListRow
          title={ALL_STABLECOINS_LABEL}
          subtitle="Every active stablecoin Pharos tracks"
          className="min-h-[3.25rem]"
          trailing={hasAnyGlobal ? (
            <>
              <span className="sr-only">Following</span>
              <Check className="h-4 w-4 shrink-0 text-[color:var(--telegram-link,var(--mini-accent))]" aria-hidden="true" />
            </>
          ) : undefined}
          chevron
          onClick={() => push({ name: "group", groupId: "all" })}
        />
      </ListSection>
    </>
  );
}
