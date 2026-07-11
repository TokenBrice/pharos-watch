"use client";

import { useMemo, useState } from "react";
import { ALERT_LABELS, PRESET_ALERT_TYPES } from "../constants";
import type {
  FollowedPreset,
  TelegramMiniAppOperation,
  TelegramMiniAppState,
} from "../types";
import { MiniButton } from "./MiniButton";
import { TogglePill } from "./TogglePill";

type PresetAlertType = (typeof PRESET_ALERT_TYPES)[number];
type RecommendedPreset = TelegramMiniAppState["catalog"]["recommendedPresets"][number];

function FollowedPresetCard({ preset, canMutate, isMutating, pendingOperation, onMutate, onUnfollow }: {
  preset: FollowedPreset;
  canMutate: boolean;
  isMutating: boolean;
  pendingOperation: TelegramMiniAppOperation | null;
  onMutate: (operation: TelegramMiniAppOperation) => void;
  onUnfollow: (preset: FollowedPreset) => void;
}) {
  const updateAlertTypes = (nextAlertTypes: Partial<Record<PresetAlertType, boolean>>) => {
    onMutate({
      kind: "follow-preset",
      presetId: preset.id,
      alertTypes: nextAlertTypes,
      depegStepBps: preset.depegStepBps,
    });
  };
  const enabledAlertTypeCount = PRESET_ALERT_TYPES.filter((type) => preset.alertTypes[type]).length;
  const finalFamilyHelpId = `preset-${preset.id}-final-family-help`;

  return (
    <article className="rounded-2xl border border-border/70 bg-card/90 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-foreground">{preset.label}</h3>
          {preset.description ? <p className="mt-1 text-xs text-muted-foreground">{preset.description}</p> : null}
        </div>
        <MiniButton
          ariaLabel={`Unfollow ${preset.label}`}
          variant="secondary"
          disabled={!canMutate || isMutating}
          loading={pendingOperation?.kind === "unfollow-preset" && pendingOperation.presetId === preset.id}
          onClick={() => onUnfollow(preset)}
        >
          Unfollow
        </MiniButton>
      </div>
      <div
        className="mt-3 flex flex-wrap gap-2"
        role="group"
        aria-label={`${preset.label} alert types`}
        aria-describedby={enabledAlertTypeCount === 1 ? finalFamilyHelpId : undefined}
      >
        {PRESET_ALERT_TYPES.map((type) => {
          const isFinalEnabledFamily = enabledAlertTypeCount === 1 && Boolean(preset.alertTypes[type]);
          return (
            <TogglePill
              key={type}
              label={ALERT_LABELS[type]}
              enabled={Boolean(preset.alertTypes[type])}
              disabled={!canMutate || isMutating || isFinalEnabledFamily}
              loading={pendingOperation?.kind === "follow-preset" && pendingOperation.presetId === preset.id}
              ariaLabel={`${preset.label} ${ALERT_LABELS[type]}`}
              onToggle={() => {
                updateAlertTypes({ ...preset.alertTypes, [type]: !preset.alertTypes[type] });
              }}
            />
          );
        })}
      </div>
      {enabledAlertTypeCount === 1 ? (
        <p id={finalFamilyHelpId} className="mt-2 text-xs text-muted-foreground">
          Keep at least one alert family enabled. Use Unfollow to stop this preset.
        </p>
      ) : null}
    </article>
  );
}

function AvailablePresetCard({ preset, canMutate, isMutating, pendingOperation, onMutate }: {
  preset: RecommendedPreset;
  canMutate: boolean;
  isMutating: boolean;
  pendingOperation: TelegramMiniAppOperation | null;
  onMutate: (operation: TelegramMiniAppOperation) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [pick, setPick] = useState<Partial<Record<PresetAlertType, boolean>>>({ dews: true, depeg: true, safety: false });
  const someSelected = PRESET_ALERT_TYPES.some((type) => pick[type]);

  return (
    <article className="rounded-2xl border border-border/70 bg-card/90 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-foreground">{preset.label}</h3>
          {preset.description ? <p className="mt-1 text-xs text-muted-foreground">{preset.description}</p> : null}
        </div>
        {!picking ? (
          <MiniButton ariaLabel={`Follow ${preset.label}`} variant="secondary" disabled={!canMutate || isMutating} onClick={() => setPicking(true)}>
            Follow
          </MiniButton>
        ) : null}
      </div>
      {picking ? (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-muted-foreground">Choose alert families to follow.</p>
          <div className="flex flex-wrap gap-2" role="group" aria-label={`${preset.label} alert types`}>
            {PRESET_ALERT_TYPES.map((type) => (
              <TogglePill
                key={type}
                label={ALERT_LABELS[type]}
                enabled={Boolean(pick[type])}
                disabled={!canMutate || isMutating}
                ariaLabel={`${preset.label} ${ALERT_LABELS[type]}`}
                onToggle={() => setPick((prev) => ({ ...prev, [type]: !prev[type] }))}
              />
            ))}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <MiniButton
              disabled={!canMutate || isMutating || !someSelected}
              loading={pendingOperation?.kind === "follow-preset" && pendingOperation.presetId === preset.id}
              onClick={() => {
                setPicking(false);
                onMutate({
                  kind: "follow-preset",
                  presetId: preset.id,
                  alertTypes: pick,
                });
              }}
            >
              Follow
            </MiniButton>
            <MiniButton variant="secondary" disabled={!canMutate || isMutating} onClick={() => setPicking(false)}>
              Cancel
            </MiniButton>
          </div>
        </div>
      ) : null}
    </article>
  );
}

export interface PresetsPanelProps {
  state: TelegramMiniAppState;
  canMutate: boolean;
  isMutating: boolean;
  pendingOperation: TelegramMiniAppOperation | null;
  onMutate: (operation: TelegramMiniAppOperation) => void;
  onUnfollowPreset: (preset: FollowedPreset) => void;
}

export function PresetsPanel({ state, canMutate, isMutating, pendingOperation, onMutate, onUnfollowPreset }: PresetsPanelProps) {
  const followedIds = useMemo(() => new Set(state.presets.map((preset) => preset.id)), [state.presets]);
  const available = useMemo(() => state.catalog.recommendedPresets.filter((preset) => !followedIds.has(preset.id)), [followedIds, state.catalog.recommendedPresets]);

  return (
    <div className="space-y-4">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Followed presets</h2>
        {state.presets.length > 0 ? state.presets.map((preset) => (
          <FollowedPresetCard
            key={preset.id}
            preset={preset}
            canMutate={canMutate}
            isMutating={isMutating}
            pendingOperation={pendingOperation}
            onMutate={onMutate}
            onUnfollow={onUnfollowPreset}
          />
        )) : (
          <section className="rounded-2xl border border-border/70 bg-card/90 p-4 text-sm text-muted-foreground">No followed presets yet. Pick one below to track a bucket of coins at once.</section>
        )}
      </section>
      {available.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-foreground">Available presets</h2>
          {available.map((preset) => (
            <AvailablePresetCard
              key={preset.id}
              preset={preset}
              canMutate={canMutate}
              isMutating={isMutating}
              pendingOperation={pendingOperation}
              onMutate={onMutate}
            />
          ))}
        </section>
      ) : null}
    </div>
  );
}
