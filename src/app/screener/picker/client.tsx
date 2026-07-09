"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  decodeSelectorState,
  highestValidStep,
  isValidSelectorSnapshotId,
  preHighlightForDepeg,
  shouldSkipExitStep,
  softConfirmationForHorizon,
  toSelectorInput,
  useSelectorState,
  type SelectorDepeg,
  type SelectorExit,
  type SelectorHorizon,
  type SelectorPeg,
  type SelectorProfile,
  type SelectorStep,
  type SelectorVenue,
} from "./selector-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useHydrated } from "@/hooks/use-hydrated";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { SelectorQuestionCard } from "@/components/selector/selector-question-card";
import { SelectorMobileForm } from "@/components/selector/selector-mobile-form";
import type { SelectorOutput } from "@shared/lib/selector";
import { ResultPane } from "./result-pane";
import {
  DEPEG_OPTIONS,
  EXIT_OPTIONS,
  HORIZON_OPTIONS,
  LEGEND_BY_PROFILE_Q4,
  PEG_OPTIONS,
  PROFILE_LABEL,
  PROFILE_OPTIONS,
  QUESTION_HELPER_COPY,
  VENUE_OPTIONS_BY_PROFILE,
  YIELD_PEG_SET,
  computeTotalSteps,
  stepLegend,
} from "./picker-options";
import {
  clearStoredSelectorRun,
  isInitialSelectorState,
  readStoredSelectorRun,
  wizardStateFromOutput,
  writeStoredSelectorRun,
} from "./session-storage";
import { useSelector } from "./use-selector";
import { RequestSequence, requestJson } from "@/lib/request";
import type { SchemaLike } from "@/lib/schema-like";

interface SnapshotWriteResponse {
  sid: string;
  ev?: string;
}

const SnapshotWriteResponseSchema: SchemaLike<SnapshotWriteResponse> = {
  safeParse(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { success: false, error: { issues: [{ path: [], message: "Expected snapshot response" }] } };
    }
    const record = value as { sid?: unknown; ev?: unknown };
    if (typeof record.sid !== "string") {
      return { success: false, error: { issues: [{ path: ["sid"], message: "Expected string" }] } };
    }
    if (record.ev !== undefined && typeof record.ev !== "string") {
      return { success: false, error: { issues: [{ path: ["ev"], message: "Expected string" }] } };
    }
    return { success: true, data: { sid: record.sid, ...(record.ev ? { ev: record.ev } : {}) } };
  },
};

export function SelectorClient() {
  const hydrated = useHydrated();
  const isMobile = useIsMobile(640);
  const { state, dispatch } = useSelectorState();
  const input = useMemo(() => toSelectorInput(state), [state]);
  const announceRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLLegendElement>(null);
  const [restoreDismissed, setRestoreDismissed] = useState(false);
  const [sessionRecovered, setSessionRecovered] = useState(false);
  const [shareFallbackUrl, setShareFallbackUrl] = useState<string | null>(null);
  const shareRequests = useRef(new RequestSequence());

  const selector = useSelector(input, state.sid);
  const output = "output" in selector ? selector.output : null;
  const renderResult = state.step === "result" || state.sid != null;
  const pegOptions = useMemo(
    () => (state.profile === "yield" ? PEG_OPTIONS.filter((option) => YIELD_PEG_SET.has(option.value)) : PEG_OPTIONS),
    [state.profile],
  );
  const mobileCompletion = useMemo(() => computeMobileCompletion(state), [state]);
  const restorableRun = useMemo(
    () => (hydrated && !restoreDismissed && isInitialSelectorState(state) ? readStoredSelectorRun() : null),
    [hydrated, restoreDismissed, state],
  );

  useEffect(() => {
    if (!hydrated) return;
    const frame = requestAnimationFrame(() => {
      legendRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [state.step, hydrated]);

  useEffect(() => () => shareRequests.current.cancel(), []);

  useEffect(() => {
    if (!announceRef.current) return;
    let msg = "";
    if (typeof state.step === "number") {
      const totalSteps = computeTotalSteps(state.profile, state.horizon, state.depegTolerance);
      msg = `Step ${state.step} of ${totalSteps}. ${stepLegend(state)}`;
    } else if (state.step === "result" && output) {
      msg = `Shortlist ready. ${output.recommended.length} candidates for ${PROFILE_LABEL[output.profile]}.`;
    }
    announceRef.current.textContent = msg;
  }, [state, output]);

  useEffect(() => {
    if (!hydrated || selector.status !== "ready" || state.step !== "result" || !output) return;
    writeStoredSelectorRun(state, output);
  }, [hydrated, selector.status, state, output]);

  const handleAdjust = useCallback(() => {
    setSessionRecovered(false);
    dispatch({ type: "adjust" });
  }, [dispatch]);

  const handleStartOver = useCallback(() => {
    shareRequests.current.cancel();
    clearStoredSelectorRun();
    setRestoreDismissed(false);
    setSessionRecovered(false);
    setShareFallbackUrl(null);
    dispatch({ type: "start-over" });
  }, [dispatch]);

  const handleBack = useCallback(() => {
    dispatch({ type: "go-back" });
  }, [dispatch]);

  const handleRestorePreviousResult = useCallback(() => {
    if (!restorableRun) return;
    setSessionRecovered(true);
    setRestoreDismissed(true);
    dispatch({ type: "restore-session", state: restorableRun.state });
  }, [dispatch, restorableRun]);

  const handleEditAnswer = useCallback(
    (step: SelectorStep, resultOutput: SelectorOutput) => {
      setSessionRecovered(false);
      dispatch({
        type: "restore-session",
        state: wizardStateFromOutput(resultOutput, state, step),
      });
    },
    [dispatch, state],
  );

  const handleCopyShareLink = useCallback(async () => {
    if (!output) throw new Error("No engine output to share");
    setShareFallbackUrl(null);
    let payload: SnapshotWriteResponse;
    try {
      payload = await shareRequests.current.run((signal) =>
        requestJson<SnapshotWriteResponse>("/selector-snapshot/", {
          signal,
          schema: SnapshotWriteResponseSchema,
          init: {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ input: output.input }),
          },
        }),
      );
    } catch (error) {
      throw new Error("Share link service unavailable", { cause: error });
    }
    if (!isValidSelectorSnapshotId(payload.sid)) {
      throw new Error("Share link service returned an invalid snapshot id");
    }
    const params = new URLSearchParams();
    params.set("sid", payload.sid);
    if (payload.ev) params.set("ev", payload.ev);
    const shareUrl = `${window.location.origin}/screener/picker/?${params.toString()}`;
    try {
      await copyToClipboard(shareUrl);
    } catch (error) {
      setShareFallbackUrl(shareUrl);
      const message =
        error instanceof Error ? error.message : "Clipboard blocked. Select and copy the share URL below.";
      throw new Error(message);
    }
  }, [output]);

  const showMobileForm =
    hydrated && isMobile && typeof state.step === "number" && state.step >= 2 && state.profile != null;
  const tradingDataStaleExceeded = isTradingDataStale(output);

  if (!hydrated) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div ref={announceRef} role="status" aria-live="polite" aria-atomic="true" className="sr-only" />

      {renderResult ? (
        <ResultPane
          selectorResult={selector}
          input={input}
          state={state}
          stateProfile={state.profile}
          isMobile={hydrated && isMobile}
          onAdjust={handleAdjust}
          onStartOver={handleStartOver}
          onEditAnswer={handleEditAnswer}
          onRelax={(key) => dispatch({ type: "relax", constraint: key })}
          onCopyShareLink={handleCopyShareLink}
          tradingStaleExceeded={tradingDataStaleExceeded}
          shareFallbackUrl={shareFallbackUrl}
          sessionRecovered={sessionRecovered}
        />
      ) : state.step === 1 ? (
        <>
          {restorableRun ? (
            <SessionRestorePanel
              savedAt={restorableRun.savedAt}
              onRestore={handleRestorePreviousResult}
              onDismiss={() => setRestoreDismissed(true)}
            />
          ) : null}
          <SelectorQuestionCard<SelectorProfile>
            ref={legendRef as React.Ref<HTMLLegendElement>}
            questionId="q1"
            step={1}
            totalSteps={computeTotalSteps(state.profile, state.horizon, state.depegTolerance)}
            legend="What are you using this stablecoin for?"
            options={PROFILE_OPTIONS}
            value={state.profile}
            onChange={(v) => dispatch({ type: "set-profile", value: v as SelectorProfile })}
            onNext={() => {
              if (state.profile) dispatch({ type: "answer-profile", value: state.profile });
            }}
          />
        </>
      ) : showMobileForm && state.profile ? (
        <SelectorMobileForm
          state={state}
          profile={state.profile}
          pegOptions={pegOptions}
          horizonOptions={HORIZON_OPTIONS}
          depegOptions={DEPEG_OPTIONS}
          venueOptions={VENUE_OPTIONS_BY_PROFILE[state.profile]}
          exitOptions={EXIT_OPTIONS}
          isVenueMulti={state.profile !== "treasury"}
          preHighlightDepeg={preHighlightForDepeg(state.profile, state.horizon)}
          legendQ2="Which peg currency should it target?"
          legendQ3="How long do you plan to hold this position?"
          legendQ4="How tight does the peg need to hold?"
          legendQ5={LEGEND_BY_PROFILE_Q4[state.profile]}
          legendQ6="If something goes wrong, how fast do you need to be out?"
          helperQ3={QUESTION_HELPER_COPY[4]}
          helperQ4={QUESTION_HELPER_COPY[5]}
          onSetPeg={(v) => dispatch({ type: "set-peg", value: v })}
          onSetHorizon={(v) => dispatch({ type: "set-horizon", value: v })}
          onSetDepeg={(v) => dispatch({ type: "set-depeg", value: v })}
          onSetVenue={(v) => dispatch({ type: "set-venue", value: v })}
          onSetExit={(v) => dispatch({ type: "set-exit", value: v })}
          onAdjustProfile={() =>
            dispatch({
              type: "restore-session",
              state: { ...state, step: 1, sid: null, ev: null },
            })
          }
          onSeeResults={() => dispatch({ type: "advance-to-result" })}
          {...mobileCompletion}
        />
      ) : state.step === 2 && state.profile ? (
        <SelectorQuestionCard<SelectorPeg>
          ref={legendRef as React.Ref<HTMLLegendElement>}
          questionId="q2"
          step={2}
          totalSteps={computeTotalSteps(state.profile, state.horizon, state.depegTolerance)}
          profileLabel={PROFILE_LABEL[state.profile]}
          legend="Which peg currency should it target?"
          legendSubtext={
            state.profile === "yield" ? "Yield is limited to pegs with benchmark and source coverage." : undefined
          }
          helper={QUESTION_HELPER_COPY[2]}
          options={pegOptions}
          value={state.pegCurrency}
          onChange={(v) => dispatch({ type: "set-peg", value: v as SelectorPeg })}
          onBack={handleBack}
          onNext={() => dispatch({ type: "answer-peg", value: state.pegCurrency })}
        />
      ) : state.step === 3 && state.profile ? (
        <SelectorQuestionCard<SelectorHorizon>
          ref={legendRef as React.Ref<HTMLLegendElement>}
          questionId="q3"
          step={3}
          totalSteps={computeTotalSteps(state.profile, state.horizon, state.depegTolerance)}
          profileLabel={PROFILE_LABEL[state.profile]}
          legend="How long do you plan to hold this position?"
          helper={QUESTION_HELPER_COPY[3]}
          options={HORIZON_OPTIONS}
          value={state.horizon}
          onChange={(v) => dispatch({ type: "set-horizon", value: v as SelectorHorizon })}
          softConfirmation={
            softConfirmationForHorizon(state.profile, state.horizon)
              ? {
                  triggerWhen: (state.profile === "trading" ? "6mplus" : "lt24h") as SelectorHorizon,
                  message: softConfirmationForHorizon(state.profile, state.horizon)!.message,
                  onContinue: () => {
                    if (state.horizon) {
                      dispatch({ type: "answer-horizon", value: state.horizon });
                    }
                  },
                  onChangeProfile: handleAdjust,
                }
              : undefined
          }
          onBack={handleBack}
          onNext={() => {
            if (state.horizon) dispatch({ type: "answer-horizon", value: state.horizon });
          }}
        />
      ) : state.step === 4 && state.profile ? (
        <SelectorQuestionCard<SelectorDepeg>
          ref={legendRef as React.Ref<HTMLLegendElement>}
          questionId="q4"
          step={4}
          totalSteps={computeTotalSteps(state.profile, state.horizon, state.depegTolerance)}
          profileLabel={PROFILE_LABEL[state.profile]}
          legend="How tight does the peg need to hold?"
          helper={QUESTION_HELPER_COPY[4]}
          options={DEPEG_OPTIONS}
          value={state.depegTolerance}
          onChange={(v) => dispatch({ type: "set-depeg", value: v as SelectorDepeg })}
          preHighlight={preHighlightForDepeg(state.profile, state.horizon)}
          onBack={handleBack}
          onNext={() => {
            if (state.depegTolerance) dispatch({ type: "answer-depeg", value: state.depegTolerance });
          }}
        />
      ) : state.step === 5 && state.profile ? (
        <SelectorQuestionCard<SelectorVenue>
          ref={legendRef as React.Ref<HTMLLegendElement>}
          questionId="q5"
          step={5}
          totalSteps={computeTotalSteps(state.profile, state.horizon, state.depegTolerance)}
          profileLabel={PROFILE_LABEL[state.profile]}
          legend={LEGEND_BY_PROFILE_Q4[state.profile]}
          helper={QUESTION_HELPER_COPY[5]}
          options={VENUE_OPTIONS_BY_PROFILE[state.profile]}
          multi={state.profile !== "treasury"}
          value={state.profile === "treasury" ? (state.venue[0] ?? null) : state.venue}
          onChange={(v) => {
            const next = Array.isArray(v) ? v : [v as SelectorVenue];
            dispatch({ type: "set-venue", value: next });
          }}
          onBack={handleBack}
          onNext={() => {
            if (state.venue.length > 0) {
              dispatch({ type: "answer-venue", value: state.venue });
            }
          }}
        />
      ) : state.step === 6 && state.profile ? (
        <SelectorQuestionCard<SelectorExit>
          ref={legendRef as React.Ref<HTMLLegendElement>}
          questionId="q6"
          step={6}
          totalSteps={computeTotalSteps(state.profile, state.horizon, state.depegTolerance)}
          profileLabel={PROFILE_LABEL[state.profile]}
          legend="If something goes wrong, how fast do you need to be out?"
          helper={QUESTION_HELPER_COPY[6]}
          options={EXIT_OPTIONS}
          value={state.exitSpeed}
          onChange={(v) => dispatch({ type: "set-exit", value: v as SelectorExit })}
          onBack={handleBack}
          onNext={() => {
            if (state.exitSpeed) dispatch({ type: "answer-exit", value: state.exitSpeed });
          }}
        />
      ) : null}
    </div>
  );
}

function SessionRestorePanel({
  savedAt,
  onRestore,
  onDismiss,
}: {
  savedAt: number;
  onRestore: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border/55 bg-card/45 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <p className="text-muted-foreground">
        Previous Picker result from {formatTimestamp(savedAt)} is available for this tab.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onRestore}
          className="pharos-focus-ring inline-flex min-h-10 items-center rounded-full border border-border/65 bg-background/60 px-3 font-medium text-foreground"
        >
          Restore previous result
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="pharos-focus-ring inline-flex min-h-10 items-center rounded-full border border-border/45 px-3 font-medium text-muted-foreground"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

async function copyToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // fall through to legacy path
    }
  }
  if (typeof document === "undefined") return;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    const copied = document.execCommand("copy");
    if (!copied) throw new Error("Clipboard blocked. Select and copy the share URL below.");
  } finally {
    document.body.removeChild(textarea);
  }
}

function isTradingDataStale(output: SelectorOutput | null): boolean {
  if (!output || output.profile !== "trading") return false;
  const enforceAllKeys = output.input.pegCurrency === "USD";
  const limits: Record<string, number> = {
    pegSummary: 10 * 60,
    dexTvl: 15 * 60,
    dews: 35 * 60,
  };
  return output.recommended.some((rec) => {
    if (rec.profile !== "trading") return false;
    const staleness = rec.perInputStaleness ?? {};
    if (enforceAllKeys && !Object.keys(limits).every((key) => key in staleness)) {
      return true;
    }
    return Object.entries(staleness).some(([key, ageSeconds]) => {
      const limit = limits[key];
      if (limit == null) return false;
      return ageSeconds > limit;
    });
  });
}

function computeMobileCompletion(state: {
  pegCurrency: SelectorPeg | null;
  profile: SelectorProfile | null;
  horizon: SelectorHorizon | null;
  depegTolerance: SelectorDepeg | null;
  venue: readonly SelectorVenue[];
  exitSpeed: SelectorExit | null;
}): {
  answeredCount: number;
  requiredCount: number;
  completionLabel: string;
} {
  const skipExit = shouldSkipExitStep(state.profile, state.horizon, state.depegTolerance);
  const requiredCount = skipExit ? 4 : 5;
  const answeredCount = [
    state.pegCurrency != null,
    state.horizon != null,
    state.depegTolerance != null,
    state.venue.length > 0,
    skipExit || state.exitSpeed != null,
  ]
    .slice(0, requiredCount)
    .filter(Boolean).length;
  return {
    answeredCount,
    requiredCount,
    completionLabel: `${answeredCount} of ${requiredCount} answers complete`,
  };
}

function formatTimestamp(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "earlier";
  }
}

export { decodeSelectorState, highestValidStep, useSelector };
export type { UseSelectorResult } from "./use-selector";
