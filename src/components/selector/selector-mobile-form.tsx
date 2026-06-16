"use client";

import { type ReactNode } from "react";
import { selectorProfileLabel } from "@shared/lib/selector/selector-labels";
import { SelectorQuestionCard, type SelectorOption } from "@/components/selector/selector-question-card";
import type {
  SelectorDepeg,
  SelectorExit,
  SelectorHorizon,
  SelectorPeg,
  SelectorProfile,
  SelectorVenue,
  SelectorWizardState,
} from "@/app/screener/picker/selector-state";
import { shouldSkipExitStep } from "@/app/screener/picker/selector-state";

interface SelectorMobileFormProps {
  state: SelectorWizardState;
  profile: SelectorProfile;
  pegOptions: readonly SelectorOption<SelectorPeg>[];
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
  legendQ6: string;
  helperQ3?: ReactNode;
  helperQ4?: ReactNode;
  onSetPeg: (value: SelectorPeg) => void;
  onSetHorizon: (value: SelectorHorizon) => void;
  onSetDepeg: (value: SelectorDepeg) => void;
  onSetVenue: (value: readonly SelectorVenue[]) => void;
  onSetExit: (value: SelectorExit) => void;
  onAdjustProfile: () => void;
  onSeeResults: () => void;
}

/**
 * Mobile-only: stacks Q2-Q6 below the Q1 answer with a single bottom CTA.
 * Uses the same `SelectorQuestionCard` primitive — the only structural
 * difference is the single submit at the bottom rather than per-step Next.
 */
export function SelectorMobileForm(props: SelectorMobileFormProps) {
  const {
    state,
    profile,
    pegOptions,
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
    legendQ6,
    helperQ3,
    helperQ4,
    onSetPeg,
    onSetHorizon,
    onSetDepeg,
    onSetVenue,
    onSetExit,
    onAdjustProfile,
    onSeeResults,
  } = props;

  const skipExit = shouldSkipExitStep(profile, state.horizon, state.depegTolerance);
  const venueValue = isVenueMulti ? state.venue : (state.venue[0] ?? null);
  const profileLabel = selectorProfileLabel(profile);
  const totalSteps = skipExit ? 5 : 6;
  const q5Topic = profile === "treasury" ? "Rails" : "Venues";

  const isReady =
    state.pegCurrency != null &&
    state.horizon != null &&
    state.depegTolerance != null &&
    state.venue.length > 0 &&
    (skipExit || state.exitSpeed != null);

  return (
    <div className="space-y-4">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-border/55 bg-card/45 px-3 py-2.5 text-sm">
        <span className="min-w-0 break-words text-muted-foreground">
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

      <SelectorQuestionCard<SelectorPeg>
        questionId="q2"
        step={2}
        totalSteps={totalSteps}
        kickerLabel="Question 2 — Peg currency"
        legend={legendQ2}
        options={pegOptions}
        value={state.pegCurrency}
        onChange={(v) => onSetPeg(v as SelectorPeg)}
        showActions={false}
      />

      <SelectorQuestionCard<SelectorHorizon>
        questionId="q3"
        step={3}
        totalSteps={totalSteps}
        kickerLabel="Question 3 — Horizon"
        legend={legendQ3}
        options={horizonOptions}
        value={state.horizon}
        onChange={(v) => onSetHorizon(v as SelectorHorizon)}
        showActions={false}
      />

      <SelectorQuestionCard<SelectorDepeg>
        questionId="q4"
        step={4}
        totalSteps={totalSteps}
        kickerLabel="Question 4 — Peg tolerance"
        legend={legendQ4}
        helper={helperQ3}
        options={depegOptions}
        value={state.depegTolerance}
        onChange={(v) => onSetDepeg(v as SelectorDepeg)}
        preHighlight={preHighlightDepeg}
        showActions={false}
      />

      <SelectorQuestionCard<SelectorVenue>
        questionId="q5"
        step={5}
        totalSteps={totalSteps}
        kickerLabel={`Question 5 — ${q5Topic}`}
        legend={legendQ5}
        helper={helperQ4}
        multi={isVenueMulti}
        options={venueOptions}
        value={venueValue}
        onChange={(v) => onSetVenue(Array.isArray(v) ? v : [v as SelectorVenue])}
        showActions={false}
      />

      {!skipExit ? (
        <SelectorQuestionCard<SelectorExit>
          questionId="q6"
          step={6}
          totalSteps={totalSteps}
          kickerLabel="Question 6 — Exit speed"
          legend={legendQ6}
          options={exitOptions}
          value={state.exitSpeed}
          onChange={(v) => onSetExit(v as SelectorExit)}
          showActions={false}
        />
      ) : null}

      <div className="sticky bottom-0 z-10 -mx-4 pharos-mobile-utility-safe border-t border-border/55 bg-background/95 px-4 py-3 backdrop-blur sm:hidden">
        <p className="mb-2 text-center text-xs text-muted-foreground" aria-live="polite">
          {answeredCount(state, skipExit)} of {skipExit ? 4 : 5} answers complete
        </p>
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

function answeredCount(state: SelectorWizardState, skipExit: boolean): number {
  return [
    state.pegCurrency,
    state.horizon,
    state.depegTolerance,
    state.venue.length > 0 ? "venue" : null,
    skipExit ? null : state.exitSpeed,
  ].filter(Boolean).length;
}
