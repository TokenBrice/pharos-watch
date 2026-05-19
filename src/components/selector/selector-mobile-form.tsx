"use client";

import { type ReactNode } from "react";
import { SelectorQuestionCard, type SelectorOption } from "@/components/selector/selector-question-card";
import type {
  SelectorDepeg,
  SelectorExit,
  SelectorHorizon,
  SelectorProfile,
  SelectorVenue,
  SelectorWizardState,
} from "@/app/screener/selector/selector-state";
import { shouldSkipExitStep } from "@/app/screener/selector/selector-state";

interface SelectorMobileFormProps {
  state: SelectorWizardState;
  profile: SelectorProfile;
  horizonOptions: readonly SelectorOption<SelectorHorizon>[];
  depegOptions: readonly SelectorOption<SelectorDepeg>[];
  venueOptions: readonly SelectorOption<SelectorVenue>[];
  exitOptions: readonly SelectorOption<SelectorExit>[];
  preHighlightDepeg?: SelectorDepeg;
  isVenueMulti: boolean;
  legendQ2: string;
  legendQ3: string;
  legendQ4: string;
  legendQ5: string;
  helperQ3?: ReactNode;
  helperQ4?: ReactNode;
  onSetHorizon: (value: SelectorHorizon) => void;
  onSetDepeg: (value: SelectorDepeg) => void;
  onSetVenue: (value: readonly SelectorVenue[]) => void;
  onSetExit: (value: SelectorExit) => void;
  onAdjustProfile: () => void;
  onSeeResults: () => void;
}

/**
 * Mobile-only: stacks Q2-Q5 below the Q1 answer with a single bottom CTA.
 * Uses the same `SelectorQuestionCard` primitive — the only structural
 * difference is the single submit at the bottom rather than per-step Next.
 */
export function SelectorMobileForm(props: SelectorMobileFormProps) {
  const {
    state,
    profile,
    horizonOptions,
    depegOptions,
    venueOptions,
    exitOptions,
    preHighlightDepeg,
    isVenueMulti,
    legendQ2,
    legendQ3,
    legendQ4,
    legendQ5,
    helperQ3,
    helperQ4,
    onSetHorizon,
    onSetDepeg,
    onSetVenue,
    onSetExit,
    onAdjustProfile,
    onSeeResults,
  } = props;

  const skipExit = shouldSkipExitStep(profile, state.horizon, state.depegTolerance);
  const venueValue = isVenueMulti ? state.venue : (state.venue[0] ?? null);
  const profileLabel = capitalize(profile);
  const totalSteps = skipExit ? 4 : 5;

  const isReady =
    state.horizon != null &&
    state.depegTolerance != null &&
    state.venue.length > 0 &&
    (skipExit || state.exitSpeed != null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border/55 bg-card/45 px-3 py-2.5 text-sm">
        <span className="text-muted-foreground">
          Profile: <span className="font-semibold text-foreground">{profileLabel}</span>
        </span>
        <button
          type="button"
          onClick={onAdjustProfile}
          className="pharos-focus-ring rounded-sm text-foreground underline underline-offset-4"
        >
          Change
        </button>
      </div>

      <SelectorQuestionCard<SelectorHorizon>
        questionId="q2"
        step={2}
        totalSteps={totalSteps}
        profileLabel={profileLabel}
        legend={legendQ2}
        options={horizonOptions}
        value={state.horizon}
        onChange={(v) => onSetHorizon(v as SelectorHorizon)}
        showActions={false}
      />

      <SelectorQuestionCard<SelectorDepeg>
        questionId="q3"
        step={3}
        totalSteps={totalSteps}
        profileLabel={profileLabel}
        legend={legendQ3}
        helper={helperQ3}
        options={depegOptions}
        value={state.depegTolerance}
        onChange={(v) => onSetDepeg(v as SelectorDepeg)}
        preHighlight={preHighlightDepeg}
        showActions={false}
      />

      <SelectorQuestionCard<SelectorVenue>
        questionId="q4"
        step={4}
        totalSteps={totalSteps}
        profileLabel={profileLabel}
        legend={legendQ4}
        helper={helperQ4}
        multi={isVenueMulti}
        options={venueOptions}
        value={venueValue}
        onChange={(v) => onSetVenue(Array.isArray(v) ? v : [v as SelectorVenue])}
        showActions={false}
      />

      {!skipExit ? (
        <SelectorQuestionCard<SelectorExit>
          questionId="q5"
          step={5}
          totalSteps={totalSteps}
          profileLabel={profileLabel}
          legend={legendQ5}
          options={exitOptions}
          value={state.exitSpeed}
          onChange={(v) => onSetExit(v as SelectorExit)}
          showActions={false}
        />
      ) : null}

      <div className="sticky bottom-0 z-10 -mx-4 pharos-mobile-utility-safe border-t border-border/55 bg-background/95 px-4 py-3 backdrop-blur sm:hidden">
        <button
          type="button"
          onClick={onSeeResults}
          disabled={!isReady}
          className="pharos-focus-ring inline-flex min-h-12 w-full items-center justify-center rounded-full border border-border/65 bg-foreground px-4 text-sm font-semibold text-background hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-55"
        >
          See my shortlist
        </button>
      </div>
    </div>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
