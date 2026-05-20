"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  decodeSelectorState,
  highestValidStep,
  isValidSelectorSnapshotId,
  preHighlightForDepeg,
  SELECTOR_STATE_DEFAULTS,
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
  type SelectorWizardState,
} from "./selector-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useHydrated } from "@/hooks/use-hydrated";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useLogos } from "@/hooks/use-logos";
import {
  usePegSummary,
  useReportCards,
  useStressSignals,
  useDexLiquidity,
  useYieldRankings,
  useBluechipRatings,
  useRedemptionBackstops,
} from "@/hooks/api-hooks";
import {
  buildScreenerUrl,
  getTemplate,
  runSelector,
  selectorAnswersToScreenerFilters,
  SELECTOR_ELIGIBLE_PEG_CURRENCIES,
  SELECTOR_YIELD_PEG_CURRENCIES,
  type SelectorInput,
  type SelectorOutput,
  type SelectorRecommendation,
} from "@shared/lib/selector";
import { PEG_METADATA } from "@shared/lib/classification";
import { buildSelectorRows } from "./selector-data-adapter";
import {
  SelectorQuestionCard,
  type SelectorOption,
} from "@/components/selector/selector-question-card";
import { SelectorMobileForm } from "@/components/selector/selector-mobile-form";
import { SelectorResultSummary } from "@/components/selector/selector-result-summary";
import { SelectorShortlistCard } from "@/components/selector/selector-shortlist-card";
import { SelectorLowerRankedRow } from "@/components/selector/selector-lower-ranked-row";
import {
  SelectorEmptyState,
  readableFailingDimension,
  type SelectorClosestSurvivor,
  type SelectorRelaxableConstraint,
} from "@/components/selector/selector-empty-state";
import { SelectorSnapshotBanner } from "@/components/selector/selector-snapshot-banner";

// ---------------------------------------------------------------------------
// Option vocabularies (UI labels)
// ---------------------------------------------------------------------------

const PROFILE_OPTIONS: readonly SelectorOption<SelectorProfile>[] = [
  {
    value: "treasury",
    label: "Hold under Treasury constraints",
    sublabel: "Park value with peg discipline; minimal DeFi interaction.",
  },
  {
    value: "yield",
    label: "Earn yield",
    sublabel: "Compose across protocols for return on idle stablecoin exposure.",
  },
  {
    value: "trading",
    label: "Trade actively",
    sublabel: "Fast settlement, tight peg, liquid exits.",
  },
];

const PEG_SUBLABEL: Record<SelectorPeg, string> = {
  USD: "Default dollar-denominated universe.",
  EUR: "Euro-denominated stablecoin universe.",
  CHF: "Swiss franc universe with yield and trading coverage.",
  GOLD: "Tokenized gold universe with live signal coverage.",
};

const PEG_OPTIONS: readonly SelectorOption<SelectorPeg>[] =
  SELECTOR_ELIGIBLE_PEG_CURRENCIES.map((value) => ({
    value,
    label: PEG_METADATA[value]?.filterLabel ?? value,
    sublabel: PEG_SUBLABEL[value],
  }));

const YIELD_PEG_SET = new Set<string>(SELECTOR_YIELD_PEG_CURRENCIES);

const HORIZON_OPTIONS: readonly SelectorOption<SelectorHorizon>[] = [
  { value: "lt24h", label: "Under 24 hours" },
  { value: "1to7d", label: "1 – 7 days" },
  { value: "1to4w", label: "1 – 4 weeks" },
  { value: "1to6m", label: "1 – 6 months" },
  { value: "6mplus", label: "6 months or more" },
];

const DEPEG_OPTIONS: readonly SelectorOption<SelectorDepeg>[] = [
  { value: "zero", label: "Zero tolerance", sublabel: "Peg holds inside 50 bps at all times." },
  { value: "tight", label: "Within 0.5%", sublabel: "Brief slippage acceptable if liquidity holds." },
  { value: "moderate", label: "Moderate", sublabel: "Short depegs OK if recovery is clean." },
];

const VENUE_OPTIONS_BY_PROFILE: Record<SelectorProfile, readonly SelectorOption<SelectorVenue>[]> = {
  yield: [
    { value: "lend", label: "Major lending protocols" },
    { value: "dex", label: "DEX liquidity pools" },
    { value: "wrap", label: "Yield-bearing wrappers" },
    { value: "all", label: "All of the above" },
  ],
  trading: [
    { value: "cex", label: "Centralized venues" },
    { value: "perps", label: "Perps DEX" },
    { value: "spot", label: "Spot DEX" },
    { value: "all", label: "All of the above" },
  ],
  treasury: [
    {
      value: "custody",
      label: "Regulated custody",
      sublabel: "Prefer issuer or custodian rails; avoid DeFi exposure.",
    },
    {
      value: "some",
      label: "Mixed rails",
      sublabel: "Custody first, with optional on-chain movement later.",
    },
    {
      value: "active",
      label: "DeFi-native / on-chain",
      sublabel: "Require on-chain custody and decentralized posture.",
    },
  ],
};

const EXIT_OPTIONS: readonly SelectorOption<SelectorExit>[] = [
  { value: "1h", label: "Under 1 hour" },
  { value: "24h", label: "Same day" },
  { value: "any", label: "Not in a hurry" },
];

const PROFILE_LABEL: Record<SelectorProfile, string> = {
  treasury: "Treasury",
  yield: "Yield",
  trading: "Active Trading",
};

const LEGEND_BY_PROFILE_Q4: Record<SelectorProfile, string> = {
  yield: "Where will you put it to work?",
  trading: "Where will you trade?",
  treasury: "What custody or rail setup do you prefer?",
};

const TRADING_SHARE_STALENESS_LIMIT_SECONDS: Record<string, number> = {
  pegSummary: 10 * 60,
  dexTvl: 15 * 60,
  dews: 35 * 60,
};
const SESSION_RESULT_STORAGE_KEY = "pharos.selector.sessionResult.v1";

const QUESTION_HELPER_COPY: Record<2 | 3 | 4 | 5 | 6, string> = {
  2: "Narrows the universe to stablecoins that target this reference asset.",
  3: "Longer horizons put more weight on resilience, dependency risk, and history.",
  4: "Tighter tolerance applies stricter peg and stress-signal thresholds before ranking.",
  5: "Rail preference changes how much custody, composability, and source exposure the Picker permits.",
  6: "Faster exits increase the importance of liquidity, DEWS, and redemption pathways.",
};

// ---------------------------------------------------------------------------
// SelectorClient
// ---------------------------------------------------------------------------

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

  const selector = useSelector(input, state.sid);
  const output = "output" in selector ? selector.output : null;
  const renderResult = state.step === "result" || state.sid != null;
  const pegOptions = useMemo(
    () => state.profile === "yield"
      ? PEG_OPTIONS.filter((option) => YIELD_PEG_SET.has(option.value))
      : PEG_OPTIONS,
    [state.profile],
  );
  const mobileCompletion = useMemo(() => computeMobileCompletion(state), [state]);
  const restorableRun = useMemo(
    () => hydrated && !restoreDismissed && isInitialSelectorState(state)
      ? readStoredSelectorRun()
      : null,
    [hydrated, restoreDismissed, state],
  );

  // Programmatic focus to the active legend on step change.
  useEffect(() => {
    if (!hydrated) return;
    const frame = requestAnimationFrame(() => {
      legendRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [state.step, hydrated]);

  // Announce step transitions to the aria-live region.
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

  const handleEditAnswer = useCallback((step: SelectorStep, resultOutput: SelectorOutput) => {
    setSessionRecovered(false);
    dispatch({
      type: "restore-session",
      state: wizardStateFromOutput(resultOutput, state, step),
    });
  }, [dispatch, state]);

  const handleCopyShareLink = useCallback(async () => {
    if (!output) throw new Error("No engine output to share");
    setShareFallbackUrl(null);
    // POST-then-copy per plan §0.
    const response = await fetch("/selector-snapshot/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(output),
    });
    if (!response.ok) {
      throw new Error("Share link service unavailable");
    }
    const payload = (await response.json()) as { sid: string; ev?: string };
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
      const message = error instanceof Error
        ? error.message
        : "Clipboard blocked. Select and copy the share URL below.";
      throw new Error(message);
    }
  }, [output]);

  // Determine if we should render the mobile single-form vs desktop per-step.
  const showMobileForm = hydrated && isMobile && typeof state.step === "number" && state.step >= 2 && state.profile != null;

  const tradingStaleExceeded = tradingShareStaleExceeded(output);

  if (!hydrated) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    );
  }

  // Render
  return (
    <div className="space-y-6">
      <div
        ref={announceRef}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      />

      {/* Wizard or result */}
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
          tradingStaleExceeded={tradingStaleExceeded}
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
          onSetVenue={(v) =>
            dispatch({
              type: "set-venue",
              value: v,
            })
          }
          onSetExit={(v) => dispatch({ type: "set-exit", value: v })}
          onAdjustProfile={() => dispatch({
            type: "restore-session",
            state: { ...state, step: 1, sid: null, ev: null },
          })}
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
            state.profile === "yield"
              ? "Yield is limited to pegs with benchmark and source coverage."
              : undefined
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

// ---------------------------------------------------------------------------
// ResultPane
// ---------------------------------------------------------------------------

interface ResultPaneProps {
  selectorResult: UseSelectorResult;
  input: SelectorInput | null;
  state: SelectorWizardState;
  stateProfile: SelectorProfile | null;
  isMobile: boolean;
  onAdjust: () => void;
  onStartOver: () => void;
  onEditAnswer: (step: SelectorStep, output: SelectorOutput) => void;
  onRelax: (key: SelectorRelaxableConstraint["key"]) => void;
  onCopyShareLink: () => Promise<void>;
  tradingStaleExceeded: boolean;
  shareFallbackUrl: string | null;
  sessionRecovered: boolean;
}

function ResultPane({
  selectorResult,
  input,
  state,
  stateProfile,
  isMobile,
  onAdjust,
  onStartOver,
  onEditAnswer,
  onRelax,
  onCopyShareLink,
  tradingStaleExceeded,
  shareFallbackUrl,
  sessionRecovered,
}: ResultPaneProps) {
  const { data: logos } = useLogos();
  const resultFocusRef = useRef<HTMLDivElement>(null);
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  const shortlistHeadingRef = useRef<HTMLHeadingElement>(null);
  const [showSnapshotComparison, setShowSnapshotComparison] = useState(false);

  const outputForFocus = "output" in selectorResult ? selectorResult.output : null;
  useEffect(() => {
    if (!outputForFocus) return;
    const frame = requestAnimationFrame(() => {
      const target = outputForFocus.recommended.length > 0
        ? resultHeadingRef.current
        : resultFocusRef.current;
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [selectorResult.status, outputForFocus]);

  if (selectorResult.status === "loading" || selectorResult.status === "snapshot-loading") {
    return (
      <div className="space-y-4" aria-busy="true" aria-live="polite">
        <p className="sr-only">Picker result is loading.</p>
        <Skeleton className="h-32 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    );
  }

  if (selectorResult.status === "error") {
    return (
      <div
        role="alert"
        className="space-y-3 rounded-lg border border-destructive/40 bg-destructive/[0.08] px-4 py-3 text-sm text-destructive"
      >
        <p>
          Selector could not produce a result ({humanizeSelectorError(selectorResult.reason)}).
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onAdjust}
            className="pharos-focus-ring inline-flex min-h-10 items-center rounded-full border border-destructive/35 px-3 text-sm font-medium"
          >
            Adjust answers
          </button>
          <button
            type="button"
            onClick={onStartOver}
            className="pharos-focus-ring inline-flex min-h-10 items-center rounded-full border border-destructive/25 px-3 text-sm font-medium"
          >
            Start over
          </button>
        </div>
      </div>
    );
  }

  const output = selectorResult.output;
  const profile = (output?.profile ?? stateProfile) as SelectorProfile;
  const effectiveInput = input ?? output.input;
  const screenerHandoff = buildScreenerHandoff(output);
  const screenerHandoffHref = screenerHandoff.url;
  const compareShortlistHref = buildCompareShortlistHref(output);
  const compareWatchoutsHref = buildCompareWithWatchoutsHref(output, state);
  const liveComparisonOutput =
    selectorResult.status === "snapshot-found" ? selectorResult.liveOutput : null;
  const snapshotBanner =
    selectorResult.status === "snapshot-found" ? (
      <SelectorSnapshotBanner
        mode="frozen"
        capturedAt={output.timestamp}
        onCompareToToday={() => setShowSnapshotComparison(true)}
      />
    ) : selectorResult.status === "snapshot-miss" ? (
      <SelectorSnapshotBanner mode="fallback" />
    ) : null;

  // Empty state
  if (output.recommended.length === 0) {
    return (
      <div ref={resultFocusRef} tabIndex={-1} className="space-y-4 outline-none">
        {snapshotBanner}
        {sessionRecovered ? <SessionRecoveredBanner /> : null}
        <SelectorEmptyState
          profile={profile}
          pegCurrency={effectiveInput.pegCurrency}
          coverageSparse={
            output.coverageWarnings.sparse ||
            output.coverageWarnings.uneven ||
            output.coverageWarnings.skippedForCoverageCount > 0
          }
          closestSurvivors={buildClosestSurvivorsFromOutput(output)}
          relaxableConstraints={buildRelaxableConstraintsFromOutput(output)}
          onRelax={onRelax}
          screenerHandoffHref={screenerHandoffHref}
        />
      </div>
    );
  }

  return (
    <div ref={resultFocusRef} tabIndex={-1} className="flex flex-col gap-6 outline-none">
      {/* Mobile reorders: profile chip + headline (in summary) first; rest below. */}
      <SelectorResultSummary
        profile={profile}
        input={effectiveInput}
        universe={output.universe}
        shortlistCount={output.recommended.length}
        screenerHandoffHref={screenerHandoffHref}
        summaryHeadingRef={resultHeadingRef}
        onAdjust={onAdjust}
        onEditAnswer={(key) => onEditAnswer(stepForAnswerKey(key), output)}
        onCopyShareLink={onCopyShareLink}
        copyShareDisabled={tradingStaleExceeded}
        copyShareDisabledReason={
          tradingStaleExceeded
            ? "Data freshness for one or more Active Trading inputs exceeds its share-link freshness limit. Refresh and retry."
            : undefined
        }
        shareFallbackUrl={shareFallbackUrl ?? undefined}
        skipped={output.coverageWarnings.skippedForCoverage}
        lowConfidence={output.lowConfidence}
        coverageWarnings={output.coverageWarnings}
        snapshotBanner={snapshotBanner}
        {...buildResultSummaryCoordinationProps({
          output,
          state,
          screenerHandoff,
        })}
      />

      {sessionRecovered ? <SessionRecoveredBanner /> : null}

      {showSnapshotComparison ? (
        <SnapshotComparisonPanel
          frozen={output}
          live={liveComparisonOutput}
          liveStatus={
            selectorResult.status === "snapshot-found"
              ? selectorResult.liveStatus
              : "unavailable"
          }
        />
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <CompareShortlistAction href={compareShortlistHref} />
        {output.lowerRanked.length > 0 ? (
          <CompareWatchoutsAction href={compareWatchoutsHref} />
        ) : null}
      </div>

      <NearMissesDisclosure survivors={buildClosestSurvivorsFromOutput(output)} />

      {/* Mobile quick-scroll jump button */}
      {isMobile ? (
        <a
          href="#selector-shortlist"
          onClick={() => {
            requestAnimationFrame(() => shortlistHeadingRef.current?.focus());
          }}
          className="pharos-focus-ring inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full border border-border/65 bg-card/50 px-3.5 text-sm font-medium text-foreground sm:hidden"
        >
          Full shortlist &amp; detail
        </a>
      ) : null}

      <section aria-labelledby="selector-shortlist-heading" className="space-y-3">
        <h2
          id="selector-shortlist-heading"
          ref={shortlistHeadingRef}
          tabIndex={-1}
          className="pharos-section-title text-base font-semibold tracking-tight text-foreground sm:text-lg"
        >
          Shortlist
        </h2>
        <ol id="selector-shortlist" className="space-y-3">
          {output.recommended.map((rec, idx) => {
            const template = getTemplate(rec.lowestSubDimension.key, rec.profile);
            const enriched = (
              template
                ? {
                    ...rec,
                    whyText: rec.whyText ?? buildWhyText(rec),
                    watchText: rec.watchText ?? template.oneLineExplanation,
                  }
                : { ...rec, whyText: rec.whyText ?? buildWhyText(rec) }
            ) as SelectorRecommendation;
            return (
              <SelectorShortlistCard
                key={rec.id}
                rank={(idx + 1) as 1 | 2 | 3}
                recommendation={enriched}
                profile={profile}
                pegCurrency={effectiveInput.pegCurrency}
                isMobile={isMobile}
                logoUrl={logos[rec.id] ?? undefined}
              />
            );
          })}
        </ol>
      </section>

      {output.lowerRanked.length > 0 ? (
        <section aria-labelledby="selector-lower-ranked-heading" className="space-y-3">
          <h2
            id="selector-lower-ranked-heading"
            className="pharos-section-title text-base font-semibold tracking-tight text-foreground sm:text-lg"
          >
            Watch-outs for this profile
          </h2>
          <ol className="space-y-2">
            {output.lowerRanked.map((entry) => (
              <SelectorLowerRankedRow
                key={entry.id}
                entry={entry}
                pegCurrency={effectiveInput.pegCurrency}
              />
            ))}
          </ol>
        </section>
      ) : null}

      <footer className="space-y-2 border-t border-border/55 pt-4 text-xs leading-relaxed text-muted-foreground">
        <p>
          Picker output uses {summarizeMethodologyVersions(output.methodologyVersions)} against
          dataset snapshot <code>{output.datasetHash}</code>. Not personalized financial advice. Does
          not account for jurisdiction, tax, counterparty agreements, or operational constraints not
          captured by the form. <em>Historical readings; future behaviour may differ.</em>
        </p>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeTotalSteps(
  profile: SelectorProfile | null,
  horizon: SelectorHorizon | null,
  depeg: SelectorDepeg | null,
): number {
  if (shouldSkipExitStep(profile, horizon, depeg)) return 5;
  return 6;
}

function stepLegend(state: { step: number | "result" }): string {
  switch (state.step) {
    case 1:
      return "What are you using this stablecoin for?";
    case 2:
      return "Which peg currency should it target?";
    case 3:
      return "How long do you plan to hold this position?";
    case 4:
      return "How tight does the peg need to hold?";
    case 5:
      return "What custody or rail setup do you prefer?";
    case 6:
      return "If something goes wrong, how fast do you need to be out?";
    default:
      return "";
  }
}

interface ScreenerHandoffView {
  url: string;
  filterChips: Array<{ label: string; value: string }>;
}

interface StoredSelectorRun {
  state: SelectorWizardState;
  output: SelectorOutput;
  savedAt: number;
}

function buildScreenerHandoff(output: SelectorOutput | null): ScreenerHandoffView {
  if (!output) return { url: "/screener/", filterChips: [] };
  try {
    const { url } = buildScreenerUrl(output.input, "/screener/");
    const { filters } = selectorAnswersToScreenerFilters(output.input);
    return {
      url,
      filterChips: readableScreenerFilterChips(filters),
    };
  } catch {
    return { url: "/screener/", filterChips: [] };
  }
}

function buildCompareWithWatchoutsHref(
  output: SelectorOutput,
  state: SelectorWizardState,
): string {
  const ids = [
    ...output.recommended.map((rec) => rec.id),
    ...output.lowerRanked.map((entry) => entry.id),
  ];
  return buildCompareHref(output, state, ids);
}

function buildCompareShortlistHref(output: SelectorOutput): string {
  const params = new URLSearchParams();
  params.set("coins", output.recommended.map((rec) => rec.id).join(","));
  return `/compare/?${params.toString()}`;
}

function buildCompareHref(
  output: SelectorOutput,
  state: SelectorWizardState,
  coinIds: readonly string[],
): string {
  const input = output.input;
  const params = new URLSearchParams();
  params.set("p", input.profile);
  params.set("peg", input.pegCurrency);
  params.set("h", input.horizon);
  params.set("d", input.depegTolerance);
  params.set("v", compareVenueParam(input, state));
  params.set("u", input.exitSpeed);
  params.set("step", "result");
  params.set("coins", Array.from(new Set(coinIds)).join(","));
  return `/compare/?${params.toString()}`;
}

function compareVenueParam(input: SelectorInput, state: SelectorWizardState): string {
  const inputVenue = venuePreferencesFromInput(input);
  if (inputVenue.length > 0) return inputVenue.join(",");

  if (
    state.profile === input.profile &&
    state.pegCurrency === input.pegCurrency &&
    state.horizon === input.horizon &&
    state.depegTolerance === input.depegTolerance &&
    state.venue.length > 0
  ) {
    return state.venue.join(",");
  }

  if (input.profile === "treasury") {
    if (input.composability === "none") return "custody";
    if (input.composability === "high") return "active";
    return "some";
  }
  if (input.composability === "high") return "all";
  return input.profile === "yield" ? "lend" : "cex";
}

function buildClosestSurvivorsFromOutput(output: SelectorOutput): SelectorClosestSurvivor[] {
  const fromEngine = (output as SelectorOutput & {
    closestSurvivors?: readonly SelectorClosestSurvivor[];
  }).closestSurvivors;
  if (fromEngine !== undefined) return fromEngine.slice(0, 3);
  return output.coverageWarnings.skippedForCoverage.slice(0, 3).map((coin) => ({
    id: coin.id,
    symbol: coin.symbol,
    failingDimension: coin.missingSignals[0] ?? "coverage gap",
    liveReading: "coverage signal unavailable",
  }));
}

function buildRelaxableConstraintsFromOutput(output: SelectorOutput): SelectorRelaxableConstraint[] {
  const fromEngine = (output as SelectorOutput & {
    relaxableConstraints?: readonly SelectorRelaxableConstraint[];
  }).relaxableConstraints;
  return fromEngine ? fromEngine.slice(0, 3) : [];
}

function summarizeMethodologyVersions(versions: SelectorOutput["methodologyVersions"]): string {
  return `safety ${versions.safetyScore}, peg/DEWS ${versions.pegScoreAndDews}, yield ${versions.yieldIntelligence}, bluechip ${versions.bluechipAlignment}, exclusions ${versions.exclusionFilters}`;
}

function formatScore(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

function readableScreenerFilterChips(filters: Record<string, unknown>): Array<{ label: string; value: string }> {
  const labels: Record<string, string> = {
    safetyGrades: "Safety grades",
    lifecycle: "Lifecycle",
    pegs: "Peg",
    safetyPegStabilityMin: "Peg stability min",
    safetyResilienceMin: "Resilience min",
    safetyDependencyRiskMin: "Dependency risk min",
    safetyLiquidityMin: "Liquidity min",
    dewsMax: "DEWS max",
    types: "Type",
    blacklistable: "Blacklistable",
    mechanisms: "Mechanism",
  };
  return Object.entries(filters).map(([key, value]) => {
    const label = labels[key] ?? key;
    const formatted = Array.isArray(value) ? value.join(", ") : String(value);
    return { label, value: formatted };
  });
}

function buildWhyText(rec: SelectorRecommendation): string {
  const strongest = rec.components
    .filter((component) => component.rawValue != null)
    .sort((a, b) => b.contribution - a.contribution)[0];
  if (strongest) {
    return `${rec.symbol} ranked here because ${readableComponentKey(strongest.key)} contributed ${strongest.contribution.toFixed(1)} points from a ${Math.round(strongest.rawValue ?? strongest.normalizedValue ?? 0)} reading.`;
  }
  return `${rec.symbol} passed the selected profile filters and ranked under the current ${PROFILE_LABEL[rec.profile]} weight set.`;
}

function readableComponentKey(key: string): string {
  const labels: Record<string, string> = {
    resilience: "resilience",
    dependencyRisk: "dependency risk",
    pharosYieldScore: "Pharos Yield Score",
    pegScoreNow: "current peg score",
    liquidity: "liquidity",
    dewsInverted: "DEWS stress",
    safetyOverall: "Safety Score",
    pegStabilityHistory: "peg history",
  };
  return labels[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
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

function SessionRecoveredBanner() {
  return (
    <div role="status" className="rounded-lg border border-frost-blue/35 bg-frost-blue/[0.06] px-4 py-3 text-sm text-foreground">
      Restored from this tab&apos;s previous live Picker result.
    </div>
  );
}

function CompareShortlistAction({ href }: { href: string }) {
  return (
    <a
      href={href}
      className="pharos-focus-ring inline-flex min-h-10 items-center justify-center rounded-full border border-foreground/60 bg-foreground px-3 text-sm font-medium text-background hover:bg-foreground/90"
    >
      Compare these
    </a>
  );
}

function CompareWatchoutsAction({ href }: { href: string }) {
  return (
    <a
      href={href}
      className="pharos-focus-ring inline-flex min-h-10 items-center justify-center rounded-full border border-border/65 bg-card/45 px-3 text-sm font-medium text-foreground hover:bg-card/70"
    >
      Compare shortlist vs watch-outs
    </a>
  );
}

function NearMissesDisclosure({
  survivors,
}: {
  survivors: readonly SelectorClosestSurvivor[];
}) {
  if (survivors.length === 0) return null;
  return (
    <details className="rounded-lg border border-border/55 bg-card/35 px-3 py-2 text-sm">
      <summary className="cursor-pointer font-medium text-foreground">
        Near misses / why not shown
      </summary>
      <ul className="mt-2 space-y-1.5 leading-relaxed">
        {survivors.map((survivor) => (
          <li key={survivor.id} className="text-muted-foreground">
            <span className="font-semibold text-foreground">{survivor.symbol}</span>
            <span>
              {" "}missed on {readableFailingDimension(survivor.failingDimension)}:{" "}
              {survivor.liveReading}
            </span>
            {survivor.hypotheticalScore != null ? (
              <span className="text-foreground">
                {" "}Hypothetical score {formatScore(survivor.hypotheticalScore)}.
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

function SnapshotComparisonPanel({
  frozen,
  live,
  liveStatus,
}: {
  frozen: SelectorOutput;
  live: SelectorOutput | null;
  liveStatus: "loading" | "ready" | "error" | "unavailable";
}) {
  if (liveStatus === "loading") {
    return (
      <div aria-busy="true" className="rounded-lg border border-border/55 bg-card/35 px-4 py-3 text-sm text-muted-foreground">
        Loading current data comparison.
      </div>
    );
  }
  if (!live || liveStatus !== "ready") {
    return (
      <div role="status" className="rounded-lg border border-border/55 bg-card/35 px-4 py-3 text-sm text-muted-foreground">
        Current comparison is unavailable for this snapshot.
      </div>
    );
  }
  const delta = compareSelectorOutputs(frozen, live);
  return (
    <section className="space-y-2 rounded-lg border border-border/55 bg-card/35 px-4 py-3 text-sm" aria-label="Current shortlist comparison">
      <p className="font-semibold text-foreground">Current shortlist comparison</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <p className="text-muted-foreground">Added today: <span className="text-foreground">{delta.added || "none"}</span></p>
        <p className="text-muted-foreground">Removed today: <span className="text-foreground">{delta.removed || "none"}</span></p>
        <p className="text-muted-foreground">Rank/score movement: <span className="text-foreground">{delta.movements || "none"}</span></p>
        <p className="text-muted-foreground">Dataset hash drift: <span className="text-foreground">{delta.datasetChanged ? "yes" : "no"}</span></p>
        <p className="text-muted-foreground">Engine version drift: <span className="text-foreground">{delta.engineVersionChanged ? "yes" : "no"}</span></p>
        <p className="text-muted-foreground">Methodology drift: <span className="text-foreground">{delta.methodologyChanged ? "yes" : "no"}</span></p>
      </div>
    </section>
  );
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

async function copyToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // fall through to legacy path
    }
  }
  // Fallback for in-app browsers (Telegram, Signal mobile).
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

function tradingShareStaleExceeded(output: SelectorOutput | null): boolean {
  if (!output || output.profile !== "trading") return false;
  return output.recommended.some((rec) => {
    if (rec.profile !== "trading") return false;
    const staleness = rec.perInputStaleness ?? {};
    if (!Object.keys(TRADING_SHARE_STALENESS_LIMIT_SECONDS).every((key) => key in staleness)) {
      return true;
    }
    return Object.entries(staleness).some(([key, ageSeconds]) => {
      const limit = TRADING_SHARE_STALENESS_LIMIT_SECONDS[key];
      return limit == null || ageSeconds > limit;
    });
  });
}

function computeMobileCompletion(state: SelectorWizardState): {
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
  ].slice(0, requiredCount).filter(Boolean).length;
  return {
    answeredCount,
    requiredCount,
    completionLabel: `${answeredCount} of ${requiredCount} answers complete`,
  };
}

function isInitialSelectorState(state: SelectorWizardState): boolean {
  return (
    state.profile == null &&
    state.pegCurrency === SELECTOR_STATE_DEFAULTS.pegCurrency &&
    state.horizon == null &&
    state.depegTolerance == null &&
    state.venue.length === 0 &&
    state.exitSpeed == null &&
    state.step === 1 &&
    state.sid == null
  );
}

function writeStoredSelectorRun(state: SelectorWizardState, output: SelectorOutput): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    const storedState = { ...state, step: "result" as const, sid: null, ev: null };
    const payload: StoredSelectorRun = {
      state: storedState,
      output,
      savedAt: Date.now(),
    };
    sessionStorage.setItem(SESSION_RESULT_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Best-effort tab-scoped recovery.
  }
}

function readStoredSelectorRun(): StoredSelectorRun | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(SESSION_RESULT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSelectorRun>;
    if (!parsed.state || !parsed.output || typeof parsed.savedAt !== "number") return null;
    const state = parsed.state;
    if (state.step !== "result" || highestValidStep(state) !== "result") return null;
    return {
      state: { ...state, sid: null, ev: null },
      output: parsed.output,
      savedAt: parsed.savedAt,
    };
  } catch {
    clearStoredSelectorRun();
    return null;
  }
}

function clearStoredSelectorRun(): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(SESSION_RESULT_STORAGE_KEY);
  } catch {
    // Ignore storage access failures.
  }
}

function wizardStateFromOutput(
  output: SelectorOutput,
  fallbackState: SelectorWizardState,
  step: SelectorStep,
): SelectorWizardState {
  const input = output.input;
  const fallbackMatchesInput =
    fallbackState.profile === input.profile &&
    fallbackState.pegCurrency === input.pegCurrency &&
    fallbackState.horizon === input.horizon &&
    fallbackState.depegTolerance === input.depegTolerance &&
    fallbackState.venue.length > 0;
  return {
    profile: input.profile,
    pegCurrency: input.pegCurrency,
    horizon: input.horizon,
    depegTolerance: input.depegTolerance,
    venue: fallbackMatchesInput ? fallbackState.venue : venueFromInput(input),
    exitSpeed: input.exitSpeed,
    step,
    sid: null,
    ev: null,
  };
}

function venueFromInput(input: SelectorInput): readonly SelectorVenue[] {
  const venue = venuePreferencesFromInput(input);
  if (venue.length > 0) return venue;

  if (input.profile === "treasury") {
    if (input.composability === "none") return ["custody"];
    if (input.composability === "high") return ["active"];
    return ["some"];
  }
  if (input.composability === "high") return ["all"];
  return input.profile === "yield" ? ["lend"] : ["cex"];
}

function venuePreferencesFromInput(input: SelectorInput): readonly SelectorVenue[] {
  const allowed = new Set(VENUE_OPTIONS_BY_PROFILE[input.profile].map((option) => option.value));
  return (input.venuePreferences ?? []).filter((value): value is SelectorVenue =>
    allowed.has(value as SelectorVenue),
  );
}

function buildResultSummaryCoordinationProps({
  output,
  state,
  screenerHandoff,
}: {
  output: SelectorOutput;
  state: SelectorWizardState;
  screenerHandoff: ScreenerHandoffView;
}): Record<string, unknown> {
  const relaxed = output as SelectorOutput & {
    usedRelaxedFallback?: boolean;
    relaxedReasons?: readonly string[];
  };
  return {
    answerChips: answerChipsFor(output.input, state),
    priorityLabels: priorityLabelsFor(output.input),
    screenerFilterChips: screenerHandoff.filterChips,
    filterChips: screenerHandoff.filterChips,
    usedRelaxedFallback: relaxed.usedRelaxedFallback ?? false,
    relaxedReasons: relaxed.relaxedReasons ?? [],
  };
}

function answerChipsFor(
  input: SelectorInput,
  state: SelectorWizardState,
): Array<{ key: string; label: string; value: string }> {
  const chips = [
    { key: "profile", label: "Profile", value: PROFILE_LABEL[input.profile] },
    { key: "peg", label: "Peg", value: PEG_METADATA[input.pegCurrency]?.filterLabel ?? input.pegCurrency },
    { key: "horizon", label: "Horizon", value: labelForOption(HORIZON_OPTIONS, input.horizon) },
    { key: "depeg", label: "Peg tolerance", value: labelForOption(DEPEG_OPTIONS, input.depegTolerance) },
    {
      key: "venue",
      label: input.profile === "treasury" ? "Rail" : "Venue",
      value: venueLabelFor(input, state),
    },
  ];
  if (!shouldSkipExitStep(input.profile, input.horizon, input.depegTolerance)) {
    chips.push({ key: "exit", label: "Exit", value: labelForOption(EXIT_OPTIONS, input.exitSpeed) });
  }
  return chips;
}

function labelForOption<T extends string>(
  options: readonly SelectorOption<T>[],
  value: T,
): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

function venueLabelFor(input: SelectorInput, state: SelectorWizardState): string {
  const venue = venuePreferencesFromInput(input);
  const values = venue.length > 0 ? venue : compareVenueParam(input, state).split(",");
  const options = VENUE_OPTIONS_BY_PROFILE[input.profile];
  return values
    .map((value) => options.find((option) => option.value === value)?.label ?? value)
    .join(", ");
}

function priorityLabelsFor(input: SelectorInput): string[] {
  if (input.profile === "treasury") {
    return ["Safety", "Resilience", "Dependency risk", "Peg discipline"];
  }
  if (input.profile === "yield") {
    return ["Yield score", "Source risk", "Variance", "Safety", "Peg discipline"];
  }
  return ["Liquidity", "Current peg quality", "DEWS", "Exit speed", "Market depth"];
}

function stepForAnswerKey(key: string): SelectorStep {
  switch (key) {
    case "profile":
      return 1;
    case "peg":
      return 2;
    case "horizon":
      return 3;
    case "depeg":
      return 4;
    case "venue":
      return 5;
    case "exit":
      return 6;
    default:
      return 1;
  }
}

function humanizeSelectorError(reason: string): string {
  const labels: Record<string, string> = {
    offline: "you appear to be offline",
    "snapshot-not-found": "snapshot not found",
    "snapshot-store-unavailable": "snapshot store unavailable",
    "snapshot-corrupt": "snapshot data is corrupt",
    "invalid-snapshot-id": "snapshot id is invalid",
    "engine-failed": "engine failed",
  };
  return labels[reason] ?? reason;
}

function compareSelectorOutputs(frozen: SelectorOutput, live: SelectorOutput): {
  added: string;
  removed: string;
  movements: string;
  datasetChanged: boolean;
  engineVersionChanged: boolean;
  methodologyChanged: boolean;
} {
  const frozenById = new Map(frozen.recommended.map((rec) => [rec.id, rec]));
  const liveById = new Map(live.recommended.map((rec) => [rec.id, rec]));
  const added = live.recommended
    .filter((rec) => !frozenById.has(rec.id))
    .map((rec) => rec.symbol)
    .join(", ");
  const removed = frozen.recommended
    .filter((rec) => !liveById.has(rec.id))
    .map((rec) => rec.symbol)
    .join(", ");
  const movements = live.recommended
    .filter((rec) => frozenById.has(rec.id))
    .map((rec) => {
      const prior = frozenById.get(rec.id)!;
      const scoreDelta = rec.score - prior.score;
      if (prior.rank === rec.rank && Math.abs(scoreDelta) < 0.05) return null;
      const sign = scoreDelta >= 0 ? "+" : "";
      return `${rec.symbol} #${prior.rank}->#${rec.rank}, ${sign}${scoreDelta.toFixed(1)}`;
    })
    .filter((item): item is string => item != null)
    .join("; ");
  return {
    added,
    removed,
    movements,
    datasetChanged: frozen.datasetHash !== live.datasetHash,
    engineVersionChanged: frozen.engineVersion !== live.engineVersion,
    methodologyChanged:
      JSON.stringify(frozen.methodologyVersions) !== JSON.stringify(live.methodologyVersions),
  };
}

// ---------------------------------------------------------------------------
// useSelector — engine orchestration (inline to keep the route to the four
// listed files).
// ---------------------------------------------------------------------------

export type UseSelectorResult =
  | { status: "loading" }
  | { status: "ready"; output: SelectorOutput }
  | { status: "snapshot-loading" }
  | {
      status: "snapshot-found";
      output: SelectorOutput;
      isFrozen: true;
      liveOutput: SelectorOutput | null;
      liveStatus: "loading" | "ready" | "error";
    }
  | { status: "snapshot-miss"; output: SelectorOutput; bannerKey: "snapshot-miss" }
  | { status: "error"; reason: string };

type SnapshotFetchResult =
  | { kind: "found"; output: SelectorOutput }
  | { kind: "missing" }
  | { kind: "error"; reason: string };

async function defaultFetchSnapshot(sid: string): Promise<SnapshotFetchResult> {
  if (!isValidSelectorSnapshotId(sid)) {
    return { kind: "error", reason: "invalid-snapshot-id" };
  }
  try {
    const response = await fetch(`/selector-snapshot/${encodeURIComponent(sid)}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (response.status === 404) return { kind: "missing" };
    if (response.status === 502) return { kind: "error", reason: "snapshot-corrupt" };
    if (response.status === 500 || response.status === 503) {
      return { kind: "error", reason: "snapshot-store-unavailable" };
    }
    if (!response.ok) throw new Error(`Snapshot fetch failed: ${response.status}`);
    return { kind: "found", output: (await response.json()) as SelectorOutput };
  } catch (error) {
    return {
      kind: "error",
      reason:
        typeof navigator !== "undefined" && navigator.onLine === false
          ? "offline"
          : error instanceof Error
            ? error.message
            : "snapshot-fetch-failed",
    };
  }
}

export function useSelector(
  input: SelectorInput | null,
  sid: string | null,
): UseSelectorResult {
  const stablecoins = useStablecoins();
  const pegSummary = usePegSummary();
  const reportCards = useReportCards();
  const stressSignals = useStressSignals();
  const dexLiquidity = useDexLiquidity();
  const yieldRankings = useYieldRankings();
  const bluechipRatings = useBluechipRatings();
  const redemptionBackstops = useRedemptionBackstops();

  const [snapshotState, setSnapshotState] = useState<
    | { kind: "idle" }
    | { kind: "loading"; sid: string }
    | { kind: "found"; sid: string; output: SelectorOutput }
    | { kind: "miss"; sid: string }
    | { kind: "error"; sid: string; reason: string }
  >(sid ? { kind: "loading", sid } : { kind: "idle" });

  useEffect(() => {
    if (!sid) {
      setSnapshotState({ kind: "idle" });
      return;
    }
    setSnapshotState({ kind: "loading", sid });
    let cancelled = false;
    void defaultFetchSnapshot(sid).then((result) => {
      if (cancelled) return;
      if (result.kind === "found") {
        setSnapshotState({ kind: "found", sid, output: result.output });
      } else if (result.kind === "missing") {
        setSnapshotState({ kind: "miss", sid });
      } else {
        setSnapshotState({ kind: "error", sid, reason: result.reason });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [sid]);

  const liveInput =
    input ?? (snapshotState.kind === "found" ? snapshotState.output.input : null);

  const datasetReady =
    stablecoins.data?.peggedAssets != null &&
    reportCards.data?.cards != null &&
    queryDataOrErrorSettled(pegSummary) &&
    queryDataOrErrorSettled(stressSignals) &&
    queryDataOrErrorSettled(dexLiquidity) &&
    queryDataOrErrorSettled(bluechipRatings) &&
    queryDataOrErrorSettled(redemptionBackstops) &&
    (liveInput?.profile !== "yield" || queryDataOrErrorSettled(yieldRankings));

  const rowsByKey = useMemo(() => {
    if (!datasetReady || !liveInput) return null;
    return buildSelectorRows({
      stablecoinsData: stablecoins.data ?? null,
      pegCurrency: liveInput.pegCurrency,
      pegData: pegSummary.data ?? null,
      reportData: reportCards.data ?? null,
      stressData: stressSignals.data ?? null,
      dexData: dexLiquidity.data ?? null,
      yieldData: yieldRankings.data ?? null,
      bluechipData: bluechipRatings.data ?? null,
      redemptionData: redemptionBackstops.data ?? null,
      now: Date.now(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    datasetReady,
    liveInput?.profile,
    liveInput?.pegCurrency,
    stablecoins.dataUpdatedAt,
    pegSummary.dataUpdatedAt,
    reportCards.dataUpdatedAt,
    stressSignals.dataUpdatedAt,
    dexLiquidity.dataUpdatedAt,
    yieldRankings.dataUpdatedAt,
    bluechipRatings.dataUpdatedAt,
    redemptionBackstops.dataUpdatedAt,
  ]);

  const engineOutput = useMemo<SelectorOutput | null>(() => {
    if (!liveInput || !rowsByKey) return null;
    try {
      return runSelector(
        liveInput,
        { rows: rowsByKey.rows },
        {
          timestamp: rowsByKey.timestamp,
          datasetHash: rowsByKey.datasetHash,
          methodologyVersions: rowsByKey.methodologyVersions,
        },
      );
    } catch {
      return null;
    }
  }, [liveInput, rowsByKey]);

  if (sid) {
    if (snapshotState.kind === "loading") return { status: "snapshot-loading" };
    if (snapshotState.kind === "found") {
      return {
        status: "snapshot-found",
        output: snapshotState.output,
        isFrozen: true,
        liveOutput: engineOutput,
        liveStatus: !datasetReady ? "loading" : engineOutput ? "ready" : "error",
      };
    }
    if (snapshotState.kind === "error") {
      return { status: "error", reason: snapshotState.reason };
    }
    if (snapshotState.kind === "miss") {
      if (!input) return { status: "error", reason: "snapshot-not-found" };
      if (!engineOutput) return { status: "snapshot-loading" };
      return { status: "snapshot-miss", output: engineOutput, bannerKey: "snapshot-miss" };
    }
  }

  if (!input) return { status: "loading" };
  if (!datasetReady) return { status: "loading" };
  if (!engineOutput) return { status: "error", reason: "engine-failed" };

  return { status: "ready", output: engineOutput };
}

function queryDataOrErrorSettled(query: { data?: unknown; error?: unknown }): boolean {
  return query.data !== undefined || query.error != null;
}

// Re-export to satisfy the import surface used by `client.test.tsx`.
export { decodeSelectorState, highestValidStep };
