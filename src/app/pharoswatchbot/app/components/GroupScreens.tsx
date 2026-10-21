"use client";

import { Fragment, useState } from "react";
import { Check } from "lucide-react";
import { TELEGRAM_PRESET_DEFINITIONS, type TelegramPresetId } from "@shared/lib/telegram-presets";
import {
  ALERT_DESCRIPTIONS,
  ALERT_LABELS,
  DEPEG_STEP_OPTIONS,
  LIVE_ALERT_TYPES,
  PRESET_ALERT_TYPES,
  PRESET_COPY,
  presetLabel,
  type PresetAlertType,
} from "../constants";
import { ALL_STABLECOINS_LABEL } from "../format";
import { usePrimaryAction } from "../primary-action";
import type { MiniAppScreen } from "../use-mini-app-view";
import type { FollowedPreset, MiniAppScreenProps, TelegramDepegStepBps, TelegramMiniAppState } from "../types";
import { ListRow, ListSection, SelectRow, Switch } from "./List";

const DEFAULT_VALUE = "default";
const DEPEG_SELECT_OPTIONS = DEPEG_STEP_OPTIONS.map((option) => ({
  value: option.value == null ? DEFAULT_VALUE : String(option.value),
  label: option.label,
}));
function parseDepegStep(value: string): TelegramDepegStepBps | null {
  return value === DEFAULT_VALUE ? null : Number(value) as TelegramDepegStepBps;
}

interface PresetShape { id: string; category: string; kind: string; pegCurrency?: string; excludePegCurrency?: string; topN?: number }
const DEFINITION_BY_ID = new Map<string, PresetShape>(
  TELEGRAM_PRESET_DEFINITIONS.map((definition) => [definition.id, definition as PresetShape]),
);

/** A followed peg-top group with a larger N on the same peg already covers this one. */
function coveringPreset(presetId: string, followed: readonly FollowedPreset[]): FollowedPreset | null {
  const definition = DEFINITION_BY_ID.get(presetId);
  if (!definition || definition.kind !== "peg-top") return null;
  return followed.find((candidate) => {
    const other = DEFINITION_BY_ID.get(candidate.id);
    return other != null
      && other.id !== definition.id
      && other.kind === "peg-top"
      && other.pegCurrency === definition.pegCurrency
      && other.excludePegCurrency === definition.excludePegCurrency
      && (other.topN ?? 0) >= (definition.topN ?? 0);
  }) ?? null;
}

function AllStablecoinsScreen({ state, canEdit, busy, pendingOperation, onMutate }: MiniAppScreenProps) {
  const global = state.subscriber.globalAlerts;
  const controlsDisabled = !canEdit || busy;
  return (
    <>
      <header className="px-1 pt-2">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">{ALL_STABLECOINS_LABEL}</h1>
        <p className="mt-1 text-sm text-pretty text-muted-foreground">Every stablecoin Pharos tracks, including ones you don&apos;t follow. Expect more messages.</p>
      </header>
      <ListSection title="Alerts" className="mt-5">
        {LIVE_ALERT_TYPES.map((type) => (
          <Fragment key={type}>
            <ListRow
              title={ALERT_LABELS[type]}
              subtitle={ALERT_DESCRIPTIONS[type]}
              className="min-h-[3.25rem]"
              trailing={(
                <Switch
                  label={`All stablecoins ${ALERT_LABELS[type]}`}
                  description={ALERT_DESCRIPTIONS[type]}
                  checked={Boolean(global[type])}
                  disabled={controlsDisabled}
                  loading={pendingOperation?.kind === "set-global" && pendingOperation.alertType === type}
                  onChange={(next) => onMutate({ kind: "set-global", alertType: type, enabled: next })}
                />
              )}
            />
            {type === "depeg" && global.depeg ? (
              <SelectRow
                inset
                id="global-depeg-step"
                title="Re-alert"
                value={global.depegStepBps == null ? DEFAULT_VALUE : String(global.depegStepBps)}
                options={DEPEG_SELECT_OPTIONS}
                disabled={controlsDisabled}
                loading={pendingOperation?.kind === "set-global-depeg-step"}
                onChange={(next) => onMutate({ kind: "set-global-depeg-step", depegStepBps: parseDepegStep(next) })}
              />
            ) : null}
          </Fragment>
        ))}
      </ListSection>
    </>
  );
}

function PresetScreen({ state, canEdit, busy, pendingOperation, onMutate, presetId, onUnfollow }: MiniAppScreenProps & {
  presetId: TelegramPresetId;
  onUnfollow: (preset: FollowedPreset) => void;
}) {
  const followed = state.presets.find((preset) => preset.id === presetId) ?? null;
  const catalogPreset = state.catalog.recommendedPresets.find((preset) => preset.id === presetId);
  const label = presetLabel(presetId, followed?.label ?? catalogPreset?.label);
  const description = PRESET_COPY[presetId]?.description ?? followed?.description ?? catalogPreset?.description ?? null;
  const [draft, setDraft] = useState<Record<PresetAlertType, boolean>>({ dews: true, depeg: true, safety: false });
  const controlsDisabled = !canEdit || busy;
  const pendingFollow = pendingOperation?.kind === "follow-preset" && pendingOperation.presetId === presetId ? pendingOperation : null;
  const pending = pendingFollow != null;
  const flags = followed ? followed.alertTypes : draft;
  const enabledCount = PRESET_ALERT_TYPES.filter((type) => flags[type]).length;
  const covering = followed ? null : coveringPreset(presetId, state.presets);

  usePrimaryAction(canEdit && !followed ? {
    text: `Follow ${label}`,
    progress: pending,
    onClick: () => {
      if (!busy && enabledCount > 0) onMutate({ kind: "follow-preset", presetId, alertTypes: draft });
    },
  } : null);

  const change = (type: PresetAlertType, next: boolean) => {
    if (!followed) {
      setDraft((current) => ({ ...current, [type]: next }));
      return;
    }
    onMutate({
      kind: "follow-preset",
      presetId,
      alertTypes: { [type]: next },
      ...(type === "depeg" && !next ? { depegStepBps: null } : {}),
    });
  };

  return (
    <>
      <header className="px-1 pt-2">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">{label}</h1>
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
        footer={enabledCount === 1 && followed ? "Keep at least one alert on, or unfollow the preset." : undefined}
      >
        {PRESET_ALERT_TYPES.map((type) => {
          const checked = Boolean(flags[type]);
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
                    disabled={controlsDisabled || (checked && enabledCount === 1)}
                    loading={followed != null && pendingFollow?.alertTypes[type] != null}
                    onChange={(next) => change(type, next)}
                  />
                )}
              />
              {type === "depeg" && followed?.alertTypes.depeg ? (
                <SelectRow
                  inset
                  id={`preset-${presetId}-depeg-step`}
                  title="Re-alert"
                  value={followed.depegStepBps == null ? DEFAULT_VALUE : String(followed.depegStepBps)}
                  options={DEPEG_SELECT_OPTIONS}
                  disabled={controlsDisabled}
                  loading={pendingFollow != null && "depegStepBps" in pendingFollow && pendingFollow.alertTypes.depeg == null}
                  onChange={(next) => onMutate({ kind: "follow-preset", presetId, alertTypes: {}, depegStepBps: parseDepegStep(next) })}
                />
              ) : null}
            </Fragment>
          );
        })}
      </ListSection>
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
  onUnfollow: (preset: FollowedPreset) => void;
}

export function GroupScreen({ groupId, onUnfollow, ...props }: GroupScreenProps) {
  if (groupId === "all") return <AllStablecoinsScreen {...props} />;
  return <PresetScreen {...props} presetId={groupId} onUnfollow={onUnfollow} />;
}

export function AddGroupScreen({ state, push }: { state: TelegramMiniAppState; push: (screen: MiniAppScreen) => void }) {
  const followedIds = new Set(state.presets.map((preset) => preset.id));
  const sections = ["By peg", "By size"] as const;
  return (
    <>
      <header className="px-1 pt-2">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Follow a preset</h1>
        <p className="mt-1 text-sm text-pretty text-muted-foreground">A preset follows a set of coins for you and updates as market caps move.</p>
      </header>
      {sections.map((section, index) => (
        <ListSection key={section} title={section} className={index === 0 ? "mt-5" : undefined}>
          {state.catalog.recommendedPresets
            .filter((preset) => (PRESET_COPY[preset.id]?.category ?? "By size") === section)
            .map((preset) => (
              <ListRow
                key={preset.id}
                title={presetLabel(preset.id, preset.label)}
                subtitle={PRESET_COPY[preset.id]?.description ?? preset.description ?? undefined}
                className="min-h-[3.25rem]"
                trailing={followedIds.has(preset.id) ? <Check className="h-4 w-4 shrink-0 text-[color:var(--telegram-link,var(--mini-accent))]" aria-label="Following" /> : undefined}
                chevron
                onClick={() => push({ name: "group", groupId: preset.id })}
              />
            ))}
        </ListSection>
      ))}
    </>
  );
}
