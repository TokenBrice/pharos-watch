"use client";

import { forwardRef, type ReactNode } from "react";
import { SelectorEmblem } from "@/components/home-alt-callouts/selector-emblem";
import { cn } from "@/lib/utils";

export interface SelectorOption<TValue extends string> {
  value: TValue;
  label: string;
  sublabel?: string;
}

export interface SelectorQuestionCardSoftConfirmation<TValue extends string> {
  /** When the active value matches this, render the inline note. */
  triggerWhen: TValue | readonly TValue[];
  message: string;
  onContinue: () => void;
  onChangeProfile: () => void;
}

export interface SelectorQuestionCardProps<TValue extends string> {
  questionId: "q1" | "q2" | "q3" | "q4" | "q5" | "q6";
  step: 1 | 2 | 3 | 4 | 5 | 6;
  totalSteps: number;
  legend: string;
  legendSubtext?: string;
  profileLabel?: string;
  /**
   * Overrides the default "Step X of Y · Profile" kicker. Used by the mobile
   * single-form, where all questions are visible at once and "of Y" adds noise.
   */
  kickerLabel?: string;
  options: readonly SelectorOption<TValue>[];
  multi?: boolean;
  value: TValue | readonly TValue[] | null;
  onChange: (value: TValue | readonly TValue[]) => void;
  preHighlight?: TValue;
  softConfirmation?: SelectorQuestionCardSoftConfirmation<TValue>;
  onBack?: () => void;
  onNext?: () => void;
  showActions?: boolean;
  /** Optional content rendered above the option grid (e.g. tooltips). */
  helper?: ReactNode;
}

function isMulti<TValue extends string>(
  value: SelectorQuestionCardProps<TValue>["value"],
): value is readonly TValue[] {
  return Array.isArray(value);
}

function isValueChecked<TValue extends string>(
  active: SelectorQuestionCardProps<TValue>["value"],
  option: TValue,
): boolean {
  if (isMulti(active)) return active.includes(option);
  return active === option;
}

function matchesSoftConfirmation<TValue extends string>(
  active: SelectorQuestionCardProps<TValue>["value"],
  trigger: TValue | readonly TValue[],
): boolean {
  if (Array.isArray(trigger)) {
    if (isMulti(active)) {
      return trigger.some((t) => active.includes(t));
    }
    return active != null && (trigger as readonly TValue[]).includes(active as TValue);
  }
  if (isMulti(active)) return active.includes(trigger as TValue);
  return active === trigger;
}

/**
 * One wizard question card. Renders <fieldset><legend>...</legend></fieldset>
 * with native radio or checkbox semantics.
 */
function SelectorQuestionCardInner<TValue extends string>(
  props: SelectorQuestionCardProps<TValue>,
  legendRef: React.Ref<HTMLLegendElement>,
) {
  const {
    questionId,
    step,
    totalSteps,
    legend,
    legendSubtext,
    profileLabel,
    kickerLabel,
    options,
    multi = false,
    value,
    onChange,
    preHighlight,
    softConfirmation,
    onBack,
    onNext,
    showActions = true,
    helper,
  } = props;

  const isValid = isMulti(value) ? value.length > 0 : value != null;
  const shouldShowActions = showActions && onNext != null;

  const showSoftConfirmation =
    softConfirmation != null && matchesSoftConfirmation(value, softConfirmation.triggerWhen);

  const groupName = `selector-${questionId}`;

  const handleToggle = (option: TValue) => {
    if (!multi) {
      onChange(option);
      return;
    }
    if (isMulti(value)) {
      if (option === ("all" as TValue)) {
        // "All of the above" — replaces selection
        onChange([option]);
        return;
      }
      const without = value.filter((v) => v !== option && v !== ("all" as TValue));
      const next = value.includes(option) ? without : [...without, option];
      onChange(next);
    } else {
      onChange([option]);
    }
  };

  return (
    <section
      aria-labelledby={`${groupName}-legend`}
      className="pharos-card-shell pharos-stagger-entrance space-y-4 p-4 sm:p-6"
    >
      <fieldset className="space-y-4">
        <legend
          id={`${groupName}-legend`}
          ref={legendRef}
          tabIndex={-1}
          className="block space-y-1.5 outline-none"
        >
          <span className="pharos-kicker inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-flex h-3.5 w-3.5 items-center justify-center text-muted-foreground">
              <SelectorEmblem />
            </span>
            <span>
              {kickerLabel ?? (
                <>
                  Step <span className="pharos-numeric">{step}</span> of <span className="pharos-numeric">{totalSteps}</span>
                  {profileLabel ? ` · ${profileLabel}` : ""}
                </>
              )}
            </span>
          </span>
          <span className="block text-lg font-semibold tracking-tight text-foreground sm:text-xl">
            {legend}
          </span>
          {legendSubtext ? (
            <span className="block text-sm text-muted-foreground">{legendSubtext}</span>
          ) : null}
        </legend>

        {helper ? <div className="text-sm text-muted-foreground">{helper}</div> : null}

        <div className="flex flex-col gap-2.5 sm:gap-3">
          {options.map((option) => {
            const checked = isValueChecked(value, option.value);
            const preHighlighted = preHighlight === option.value && !checked;
            const inputType = multi ? "checkbox" : "radio";
            return (
              <label
                key={option.value}
                className={cn(
                  "pharos-focus-ring flex min-h-14 cursor-pointer items-start gap-3 rounded-xl border border-border/55 bg-background/50 px-3.5 py-3 text-left transition-colors hover:border-border/85 hover:bg-background/70 focus-within:border-foreground/65 focus-within:bg-background/80 focus-within:ring-2 focus-within:ring-ring/35 sm:min-h-12 sm:gap-3.5",
                  checked && "border-foreground/65 bg-background/85 ring-1 ring-foreground/15",
                  preHighlighted && "border-foreground/40 bg-background/70",
                )}
                data-prehighlight={preHighlighted ? "true" : undefined}
              >
                <input
                  type={inputType}
                  name={groupName}
                  value={option.value}
                  checked={checked}
                  onChange={() => handleToggle(option.value)}
                  className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-foreground"
                />
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="block text-sm font-semibold tracking-tight text-foreground sm:text-base">
                    {option.label}
                  </span>
                  {option.sublabel ? (
                    <span className="block text-xs leading-relaxed text-muted-foreground sm:text-sm">
                      {option.sublabel}
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>

        {showSoftConfirmation && softConfirmation ? (
          <div
            role="status"
            key={softConfirmation.message}
            className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2.5 text-sm text-amber-900 dark:text-amber-100"
          >
            <p>{softConfirmation.message}</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={softConfirmation.onContinue}
                className="pharos-focus-ring rounded-full border border-amber-700/35 bg-amber-100/55 px-3 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100/85 dark:bg-amber-500/15 dark:text-amber-100"
              >
                Continue
              </button>
              <button
                type="button"
                onClick={softConfirmation.onChangeProfile}
                className="pharos-focus-ring rounded-full border border-amber-700/25 px-3 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100/35 dark:text-amber-100"
              >
                Change profile
              </button>
            </div>
          </div>
        ) : null}
      </fieldset>

      {shouldShowActions ? (
        <div className="flex items-center justify-between gap-3 pt-1">
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              className="pharos-focus-ring inline-flex min-h-11 items-center rounded-full border border-border/65 px-4 text-sm font-medium text-foreground hover:bg-muted/35 sm:min-h-9"
            >
              Back
            </button>
          ) : (
            <span aria-hidden="true" />
          )}
          <button
            type="button"
            onClick={onNext}
            disabled={!isValid}
            className={cn(
              "pharos-focus-ring inline-flex min-h-11 items-center rounded-full border border-border/65 bg-foreground px-4 text-sm font-medium text-background hover:bg-foreground/90 disabled:cursor-not-allowed disabled:border-border/55 disabled:bg-muted/50 disabled:text-muted-foreground sm:min-h-9",
            )}
          >
            {step === totalSteps ? "See my shortlist" : "Next"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

export const SelectorQuestionCard = forwardRef(SelectorQuestionCardInner) as <TValue extends string>(
  props: SelectorQuestionCardProps<TValue> & { ref?: React.Ref<HTMLLegendElement> },
) => ReturnType<typeof SelectorQuestionCardInner>;
