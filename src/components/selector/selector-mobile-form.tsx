"use client";

import { selectorProfileLabel } from "@shared/lib/selector/selector-labels";
import { SelectorQuestionCard } from "@/components/selector/selector-question-card";
import { SELECTOR_QUESTIONS, computeTotalSteps } from "@/lib/selector-options";
import type {
  SelectorAction,
  SelectorProfile,
  SelectorWizardState,
} from "@/lib/selector-state";
import { shouldSkipExitStep } from "@/lib/selector-state";

interface SelectorMobileFormProps {
  state: SelectorWizardState;
  profile: SelectorProfile;
  onAnswer: (action: SelectorAction) => void;
  onAdjustProfile: () => void;
  onSeeResults: () => void;
}

/**
 * Mobile-only: stacks Q2-Q6 below the Q1 answer with a single bottom CTA.
 * Uses the same `SelectorQuestionCard` primitive and the same `SELECTOR_QUESTIONS`
 * descriptors as the desktop wizard — the only structural difference is the single
 * submit at the bottom rather than per-step Next.
 */
export function SelectorMobileForm({
  state,
  profile,
  onAnswer,
  onAdjustProfile,
  onSeeResults,
}: SelectorMobileFormProps) {
  const skipExit = shouldSkipExitStep(profile, state.horizon, state.depegTolerance);
  const profileLabel = selectorProfileLabel(profile);
  const totalSteps = computeTotalSteps(profile, state.horizon, state.depegTolerance);

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

      {SELECTOR_QUESTIONS.filter((question) => !(skipExit && question.questionId === "q6")).map((question) => (
        <SelectorQuestionCard
          key={question.questionId}
          questionId={question.questionId}
          step={question.step}
          totalSteps={totalSteps}
          kickerLabel={question.kickerLabel(profile)}
          legend={question.legend(profile)}
          helper={question.helper}
          options={question.options(profile)}
          multi={question.multi?.(profile)}
          value={question.value(state, profile)}
          preHighlight={question.preHighlight?.(state, profile)}
          onChange={(v) => onAnswer(question.setAction(v))}
          showActions={false}
        />
      ))}

      <div className="sticky bottom-0 z-10 -mx-4 pharos-mobile-utility-safe border-t border-border/55 bg-background/95 px-4 py-3 backdrop-blur sm:hidden">
        <p className="mb-2 text-center text-xs text-muted-foreground" aria-live="polite">
          {answeredCount(state, skipExit)} of {skipExit ? 4 : 5} answers complete
        </p>
        <button
          type="button"
          onClick={onSeeResults}
          disabled={!isReady}
          className="pharos-focus-ring inline-flex min-h-12 w-full items-center justify-center rounded-full border border-border/65 bg-foreground px-4 text-sm font-semibold text-background hover:bg-foreground/90 disabled:cursor-not-allowed disabled:border-border/55 disabled:bg-muted/50 disabled:text-muted-foreground"
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
