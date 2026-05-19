"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  decodeSelectorState,
  highestValidStep,
  preHighlightForDepeg,
  shouldSkipExitStep,
  softConfirmationForHorizon,
  toSelectorInput,
  useSelectorState,
  type SelectorDepeg,
  type SelectorExit,
  type SelectorHorizon,
  type SelectorProfile,
  type SelectorVenue,
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
} from "@/hooks/api-hooks";
import { CLIENT_TRACKED_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import { getCirculatingRaw } from "@shared/lib/supply";
import {
  buildScreenerUrl,
  canonicalizeForDatasetHash,
  getTemplate,
  runSelector,
  type SelectorInput,
  type SelectorOutput,
  type MergedRow,
  type SelectorRecommendation,
} from "@shared/lib/selector";
import {
  SelectorQuestionCard,
  type SelectorOption,
} from "@/components/selector/selector-question-card";
import { SelectorMobileForm } from "@/components/selector/selector-mobile-form";
import { SelectorResultSummary } from "@/components/selector/selector-result-summary";
import { SelectorShortlistCard } from "@/components/selector/selector-shortlist-card";
import { SelectorLowerRankedRow } from "@/components/selector/selector-lower-ranked-row";
import { SelectorEmptyState, type SelectorClosestSurvivor, type SelectorRelaxableConstraint } from "@/components/selector/selector-empty-state";
import { SelectorSnapshotBanner } from "@/components/selector/selector-snapshot-banner";

// ---------------------------------------------------------------------------
// Option vocabularies (UI labels)
// ---------------------------------------------------------------------------

const PROFILE_OPTIONS: readonly SelectorOption<SelectorProfile>[] = [
  {
    value: "treasury",
    label: "Hold safely (Treasury)",
    sublabel: "Park USD with peg discipline; minimal DeFi interaction.",
  },
  {
    value: "yield",
    label: "Earn yield",
    sublabel: "Compose across protocols for return on idle USD.",
  },
  {
    value: "trading",
    label: "Trade actively",
    sublabel: "Fast settlement, tight peg, liquid exits.",
  },
];

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
    { value: "custody", label: "Pure custody, no DeFi" },
    { value: "some", label: "Some DeFi later, opportunistic" },
    { value: "active", label: "Active DeFi treasury management" },
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
  treasury: "How will you use the position?",
};

// ---------------------------------------------------------------------------
// SelectorClient
// ---------------------------------------------------------------------------

export function SelectorClient() {
  const hydrated = useHydrated();
  const isMobile = useIsMobile(640);
  const { state, dispatch, setStep } = useSelectorState();
  const input = useMemo(() => toSelectorInput(state), [state]);
  const announceRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLLegendElement>(null);

  const selector = useSelector(input, state.sid);
  const output = "output" in selector ? selector.output : null;

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

  const handleAdjust = useCallback(() => {
    dispatch({ type: "adjust" });
  }, [dispatch]);

  const handleBack = useCallback(() => {
    dispatch({ type: "go-back" });
  }, [dispatch]);

  const handleCopyShareLink = useCallback(async () => {
    if (!output) throw new Error("No engine output to share");
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
    const params = new URLSearchParams(window.location.search);
    params.set("sid", payload.sid);
    if (payload.ev) params.set("ev", payload.ev);
    const shareUrl = `${window.location.origin}/screener/selector/?${params.toString()}`;
    await copyToClipboard(shareUrl);
  }, [output]);

  // Determine if we should render the mobile single-form vs desktop per-step.
  const showMobileForm = hydrated && isMobile && typeof state.step === "number" && state.step >= 2 && state.profile != null;

  // Determine if Trading-staleness CTA should be disabled. The freshness
  // ceiling is enforced by the engine output's `perInputStaleness` map; the
  // hook layer mirrors the boolean here once the result lands.
  // TODO(integration): wire through per-input dataUpdatedAt from the hooks if
  // the engine output's staleness is not yet populated.
  const tradingStaleExceeded = false;

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
      {state.step === 1 ? (
        <SelectorQuestionCard<SelectorProfile>
          ref={legendRef as React.Ref<HTMLLegendElement>}
          questionId="q1"
          step={1}
          totalSteps={computeTotalSteps(state.profile, state.horizon, state.depegTolerance)}
          legend="What are you using this stablecoin for?"
          options={PROFILE_OPTIONS}
          value={state.profile}
          onChange={(v) => dispatch({ type: "answer-profile", value: v as SelectorProfile })}
          onNext={() => {
            if (state.profile) setStep(2);
          }}
        />
      ) : showMobileForm && state.profile ? (
        <SelectorMobileForm
          state={state}
          profile={state.profile}
          horizonOptions={HORIZON_OPTIONS}
          depegOptions={DEPEG_OPTIONS}
          venueOptions={VENUE_OPTIONS_BY_PROFILE[state.profile]}
          exitOptions={EXIT_OPTIONS}
          isVenueMulti={state.profile !== "treasury"}
          preHighlightDepeg={preHighlightForDepeg(state.profile, state.horizon)}
          legendQ2="How long do you plan to hold this position?"
          legendQ3="How tight does the peg need to hold?"
          legendQ4={LEGEND_BY_PROFILE_Q4[state.profile]}
          legendQ5="If something goes wrong, how fast do you need to be out?"
          onSetHorizon={(v) => dispatch({ type: "answer-horizon", value: v })}
          onSetDepeg={(v) => dispatch({ type: "answer-depeg", value: v })}
          onSetVenue={(v) =>
            dispatch({
              // Mobile single-form: same multi-vs-single distinction. Treasury
              // venue is single-select; Yield/Trading are multi-select.
              type: state.profile === "treasury" ? "answer-venue" : "set-venue",
              value: v,
            })
          }
          onSetExit={(v) => dispatch({ type: "answer-exit", value: v })}
          onAdjustProfile={() => setStep(1)}
          onSeeResults={() => dispatch({ type: "advance-to-result" })}
        />
      ) : state.step === 2 && state.profile ? (
        <SelectorQuestionCard<SelectorHorizon>
          ref={legendRef as React.Ref<HTMLLegendElement>}
          questionId="q2"
          step={2}
          totalSteps={computeTotalSteps(state.profile, state.horizon, state.depegTolerance)}
          profileLabel={PROFILE_LABEL[state.profile]}
          legend="How long do you plan to hold this position?"
          options={HORIZON_OPTIONS}
          value={state.horizon}
          onChange={(v) => dispatch({ type: "answer-horizon", value: v as SelectorHorizon })}
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
      ) : state.step === 3 && state.profile ? (
        <SelectorQuestionCard<SelectorDepeg>
          ref={legendRef as React.Ref<HTMLLegendElement>}
          questionId="q3"
          step={3}
          totalSteps={computeTotalSteps(state.profile, state.horizon, state.depegTolerance)}
          profileLabel={PROFILE_LABEL[state.profile]}
          legend="How tight does the peg need to hold?"
          options={DEPEG_OPTIONS}
          value={state.depegTolerance}
          onChange={(v) => dispatch({ type: "answer-depeg", value: v as SelectorDepeg })}
          preHighlight={preHighlightForDepeg(state.profile, state.horizon)}
          onBack={handleBack}
          onNext={() => {
            if (state.depegTolerance) dispatch({ type: "answer-depeg", value: state.depegTolerance });
          }}
        />
      ) : state.step === 4 && state.profile ? (
        <SelectorQuestionCard<SelectorVenue>
          ref={legendRef as React.Ref<HTMLLegendElement>}
          questionId="q4"
          step={4}
          totalSteps={computeTotalSteps(state.profile, state.horizon, state.depegTolerance)}
          profileLabel={PROFILE_LABEL[state.profile]}
          legend={LEGEND_BY_PROFILE_Q4[state.profile]}
          options={VENUE_OPTIONS_BY_PROFILE[state.profile]}
          multi={state.profile !== "treasury"}
          value={state.profile === "treasury" ? (state.venue[0] ?? null) : state.venue}
          onChange={(v) => {
            const next = Array.isArray(v) ? v : [v as SelectorVenue];
            // Treasury Q4 is single-select → advance immediately.
            // Yield / Trading Q4 is multi-select → only update selection;
            // user advances by clicking Next.
            if (state.profile === "treasury") {
              dispatch({ type: "answer-venue", value: next });
            } else {
              dispatch({ type: "set-venue", value: next });
            }
          }}
          onBack={handleBack}
          onNext={() => {
            if (state.venue.length > 0) {
              dispatch({ type: "answer-venue", value: state.venue });
            }
          }}
        />
      ) : state.step === 5 && state.profile ? (
        <SelectorQuestionCard<SelectorExit>
          ref={legendRef as React.Ref<HTMLLegendElement>}
          questionId="q5"
          step={5}
          totalSteps={computeTotalSteps(state.profile, state.horizon, state.depegTolerance)}
          profileLabel={PROFILE_LABEL[state.profile]}
          legend="If something goes wrong, how fast do you need to be out?"
          options={EXIT_OPTIONS}
          value={state.exitSpeed}
          onChange={(v) => dispatch({ type: "answer-exit", value: v as SelectorExit })}
          onBack={handleBack}
          onNext={() => {
            if (state.exitSpeed) dispatch({ type: "answer-exit", value: state.exitSpeed });
          }}
        />
      ) : state.step === "result" ? (
        <ResultPane
          selectorResult={selector}
          input={input}
          stateProfile={state.profile}
          isMobile={hydrated && isMobile}
          onAdjust={handleAdjust}
          onRelax={(key) => dispatch({ type: "relax", constraint: key })}
          onCopyShareLink={handleCopyShareLink}
          tradingStaleExceeded={tradingStaleExceeded}
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
  stateProfile: SelectorProfile | null;
  isMobile: boolean;
  onAdjust: () => void;
  onRelax: (key: SelectorRelaxableConstraint["key"]) => void;
  onCopyShareLink: () => Promise<void>;
  tradingStaleExceeded: boolean;
}

function ResultPane({
  selectorResult,
  input,
  stateProfile,
  isMobile,
  onAdjust,
  onRelax,
  onCopyShareLink,
  tradingStaleExceeded,
}: ResultPaneProps) {
  const { data: logos } = useLogos();

  if (selectorResult.status === "loading" || selectorResult.status === "snapshot-loading") {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    );
  }

  if (selectorResult.status === "error") {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/[0.08] px-4 py-3 text-sm text-destructive">
        Selector engine could not produce a result ({selectorResult.reason}). Try adjusting your answers.
      </div>
    );
  }

  const output = selectorResult.output;
  const profile = (output?.profile ?? stateProfile) as SelectorProfile;
  const screenerHandoffHref = buildScreenerHref(output);
  const snapshotBanner =
    selectorResult.status === "snapshot-found" ? (
      <SelectorSnapshotBanner mode="frozen" capturedAt={output.timestamp} />
    ) : selectorResult.status === "snapshot-miss" ? (
      <SelectorSnapshotBanner mode="fallback" />
    ) : null;

  // Empty state
  if (output.recommended.length === 0) {
    return (
      <div className="space-y-4">
        {snapshotBanner}
        <SelectorEmptyState
          profile={profile}
          closestSurvivors={buildClosestSurvivorsFromOutput(output)}
          relaxableConstraints={defaultRelaxableConstraintsFor(profile, input)}
          onRelax={onRelax}
          screenerHandoffHref={screenerHandoffHref}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Mobile reorders: profile chip + headline (in summary) first; rest below. */}
      <SelectorResultSummary
        profile={profile}
        input={input!}
        universe={output.universe}
        shortlistCount={output.recommended.length}
        screenerHandoffHref={screenerHandoffHref}
        onAdjust={onAdjust}
        onCopyShareLink={onCopyShareLink}
        copyShareDisabled={tradingStaleExceeded}
        copyShareDisabledReason={
          tradingStaleExceeded
            ? "Data freshness for one or more Trading inputs exceeds the share-link ceiling. Refresh and retry."
            : undefined
        }
        skipped={output.coverageWarnings.skippedForCoverage}
        snapshotBanner={snapshotBanner}
      />

      {/* Mobile quick-scroll jump button */}
      {isMobile ? (
        <a
          href="#selector-shortlist"
          className="pharos-focus-ring inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full border border-border/65 bg-card/50 px-3.5 text-sm font-medium text-foreground sm:hidden"
        >
          Full shortlist &amp; detail
        </a>
      ) : null}

      <section aria-labelledby="selector-shortlist-heading" className="space-y-3">
        <h2
          id="selector-shortlist-heading"
          className="pharos-section-title text-base font-semibold tracking-tight text-foreground sm:text-lg"
        >
          Shortlist
        </h2>
        <ol id="selector-shortlist" className="space-y-3">
          {output.recommended.map((rec, idx) => {
            const template = getTemplate(rec.lowestSubDimension.key, rec.profile);
            const enriched = (
              template
                ? { ...rec, watchText: template.oneLineExplanation }
                : rec
            ) as SelectorRecommendation;
            return (
              <SelectorShortlistCard
                key={rec.id}
                rank={(idx + 1) as 1 | 2 | 3}
                recommendation={enriched}
                profile={profile}
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
            Lower-ranked for this profile
          </h2>
          <ol className="space-y-2">
            {output.lowerRanked.map((entry) => (
              <SelectorLowerRankedRow key={entry.id} entry={entry} />
            ))}
          </ol>
        </section>
      ) : null}

      <footer className="space-y-2 border-t border-border/55 pt-4 text-xs leading-relaxed text-muted-foreground">
        <p>
          Selector output uses {summarizeMethodologyVersions(output.methodologyVersions)} against
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
  if (shouldSkipExitStep(profile, horizon, depeg)) return 4;
  return 5;
}

function stepLegend(state: { step: number | "result" }): string {
  switch (state.step) {
    case 1:
      return "What are you using this stablecoin for?";
    case 2:
      return "How long do you plan to hold this position?";
    case 3:
      return "How tight does the peg need to hold?";
    case 4:
      return "Where will you put it to work?";
    case 5:
      return "If something goes wrong, how fast do you need to be out?";
    default:
      return "";
  }
}

function buildScreenerHref(output: SelectorOutput | null): string {
  if (!output) return "/screener/";
  try {
    const { url } = buildScreenerUrl(output.input, "/screener/");
    return url;
  } catch {
    return "/screener/";
  }
}

function buildClosestSurvivorsFromOutput(output: SelectorOutput): SelectorClosestSurvivor[] {
  // TODO(integration): engine should emit a `closestSurvivors` slot. Until then,
  // derive a placeholder from the coverage-skipped list so the empty-state panel
  // never renders empty.
  return output.coverageWarnings.skippedForCoverage.slice(0, 3).map((coin) => ({
    id: coin.id,
    symbol: coin.symbol,
    failingDimension: coin.missingSignals[0] ?? "coverage gap",
    liveReading: "data not yet captured",
  }));
}

function defaultRelaxableConstraintsFor(
  profile: SelectorProfile,
  input: SelectorInput | null,
): SelectorRelaxableConstraint[] {
  if (!input) return [];
  const out: SelectorRelaxableConstraint[] = [];
  if (input.depegTolerance === "zero") {
    out.push({
      key: "depegTolerance",
      label: "Relax depeg tolerance",
      description: "Zero → Tight",
    });
  } else if (input.depegTolerance === "tight") {
    out.push({
      key: "depegTolerance",
      label: "Relax depeg tolerance",
      description: "Tight → Moderate",
    });
  }
  if (profile !== "treasury" && input.composability !== "high") {
    out.push({
      key: "venue",
      label: "Open venue scope",
      description: "Single rail → All",
    });
  }
  if (input.exitSpeed !== "any") {
    out.push({
      key: "exitSpeed",
      label: "Loosen exit speed",
      description: "Tighter → Any",
    });
  }
  return out;
}

function summarizeMethodologyVersions(versions: SelectorOutput["methodologyVersions"]): string {
  return `safety ${versions.safetyScore}, peg/DEWS ${versions.pegScoreAndDews}, yield ${versions.yieldIntelligence}, bluechip ${versions.bluechipAlignment}, exclusions ${versions.exclusionFilters}`;
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
    document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}

// ---------------------------------------------------------------------------
// useSelector — engine orchestration (inline to keep the route to the four
// listed files).
// ---------------------------------------------------------------------------

export type UseSelectorResult =
  | { status: "loading" }
  | { status: "ready"; output: SelectorOutput }
  | { status: "snapshot-loading" }
  | { status: "snapshot-found"; output: SelectorOutput; isFrozen: true }
  | { status: "snapshot-miss"; output: SelectorOutput; bannerKey: "snapshot-miss" }
  | { status: "error"; reason: string };

async function defaultFetchSnapshot(sid: string): Promise<SelectorOutput | null> {
  try {
    const response = await fetch(`/selector-snapshot/${encodeURIComponent(sid)}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Snapshot fetch failed: ${response.status}`);
    return (await response.json()) as SelectorOutput;
  } catch {
    return null;
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

  const [snapshotState, setSnapshotState] = useState<
    | { kind: "idle" }
    | { kind: "loading"; sid: string }
    | { kind: "found"; sid: string; output: SelectorOutput }
    | { kind: "miss"; sid: string }
  >(sid ? { kind: "loading", sid } : { kind: "idle" });

  useEffect(() => {
    if (!sid) {
      setSnapshotState({ kind: "idle" });
      return;
    }
    setSnapshotState({ kind: "loading", sid });
    let cancelled = false;
    void defaultFetchSnapshot(sid).then((output) => {
      if (cancelled) return;
      if (output) {
        setSnapshotState({ kind: "found", sid, output });
      } else {
        setSnapshotState({ kind: "miss", sid });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [sid]);

  const datasetReady =
    stablecoins.data?.peggedAssets != null && reportCards.data?.cards != null;

  const rowsByKey = useMemo(() => {
    if (!datasetReady) return null;
    return buildSelectorRows({
      stablecoinsData: stablecoins.data ?? null,
      pegData: pegSummary.data ?? null,
      reportData: reportCards.data ?? null,
      stressData: stressSignals.data ?? null,
      dexData: dexLiquidity.data ?? null,
      yieldData: yieldRankings.data ?? null,
      bluechipData: bluechipRatings.data ?? null,
      now: Date.now(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    datasetReady,
    stablecoins.dataUpdatedAt,
    pegSummary.dataUpdatedAt,
    reportCards.dataUpdatedAt,
    stressSignals.dataUpdatedAt,
    dexLiquidity.dataUpdatedAt,
    yieldRankings.dataUpdatedAt,
    bluechipRatings.dataUpdatedAt,
  ]);

  const engineOutput = useMemo<SelectorOutput | null>(() => {
    if (!input || !rowsByKey) return null;
    try {
      return runSelector(
        input,
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
  }, [input, rowsByKey]);

  if (sid) {
    if (snapshotState.kind === "loading") return { status: "snapshot-loading" };
    if (snapshotState.kind === "found") {
      return { status: "snapshot-found", output: snapshotState.output, isFrozen: true };
    }
    if (snapshotState.kind === "miss") {
      if (!engineOutput) return { status: "snapshot-loading" };
      return { status: "snapshot-miss", output: engineOutput, bannerKey: "snapshot-miss" };
    }
  }

  if (!input) return { status: "loading" };
  if (!datasetReady) return { status: "loading" };
  if (!engineOutput) return { status: "error", reason: "engine-failed" };

  return { status: "ready", output: engineOutput };
}

// ---------------------------------------------------------------------------
// buildSelectorRows
// Hook responses do not yet expose every field the engine consumes (depeg
// history, yield variance/source-switch, peg deviation bps, per-input
// staleness). Those default to null/empty and route through the engine's
// Penalty + redistribute / coverage-too-thin paths.
// ---------------------------------------------------------------------------

interface BuildSelectorRowsArgs {
  stablecoinsData: { peggedAssets?: unknown[] } | null;
  pegData: { coins?: Array<{ id: string; pegScore: number | null }> } | null;
  reportData: {
    cards?: Array<{
      id: string;
      overallGrade: string | null;
      overallScore: number | null;
      dimensions: {
        pegStability: { score: number | null };
        liquidity: { score: number | null };
        resilience: { score: number | null };
        decentralization: { score: number | null };
        dependencyRisk: { score: number | null };
      };
    }>;
    methodology?: { version?: string };
  } | null;
  stressData: { signals?: Record<string, { score: number | null; activeDepeg?: boolean }> } | null;
  dexData: Record<string, {
    liquidityScore?: number | null;
    effectiveTvlUsd?: number | null;
    concentrationHhi?: number | null;
    chainTvl?: Record<string, number>;
    effectiveExitScore?: number | null;
  }> | null;
  yieldData: { rankings?: Array<{
    id: string;
    pharosYieldScore: number | null;
    apy30d: number | null;
    source?: { protocol: string; chain: string; sourceRiskTier?: "low" | "mid" | "high" };
  }> } | null;
  bluechipData: Record<string, { grade?: string | null }> | null;
  now: number;
}

interface BuildSelectorRowsResult {
  rows: ReadonlyMap<string, MergedRow>;
  timestamp: number;
  datasetHash: string;
  methodologyVersions: SelectorOutput["methodologyVersions"];
}

function buildSelectorRows(args: BuildSelectorRowsArgs): BuildSelectorRowsResult {
  const rows = new Map<string, MergedRow>();
  const pegById = new Map<string, number | null>();
  for (const coin of args.pegData?.coins ?? []) {
    pegById.set(coin.id, coin.pegScore);
  }
  const dewsById = new Map<string, { score: number | null; activeDepeg: boolean }>();
  for (const [id, entry] of Object.entries(args.stressData?.signals ?? {})) {
    dewsById.set(id, { score: entry.score ?? null, activeDepeg: entry.activeDepeg ?? false });
  }
  type ReportCard = NonNullable<NonNullable<BuildSelectorRowsArgs["reportData"]>["cards"]>[number];
  const reportById = new Map<string, ReportCard>();
  for (const card of args.reportData?.cards ?? []) {
    reportById.set(card.id, card);
  }
  type YieldEntry = NonNullable<NonNullable<BuildSelectorRowsArgs["yieldData"]>["rankings"]>[number];
  const yieldById = new Map<string, YieldEntry>();
  for (const ranking of args.yieldData?.rankings ?? []) {
    yieldById.set(ranking.id, ranking);
  }

  const supplyById = new Map<string, number>();
  for (const asset of args.stablecoinsData?.peggedAssets ?? []) {
    const a = asset as { id?: string };
    if (a.id) {
      supplyById.set(a.id, getCirculatingRaw(asset as Parameters<typeof getCirculatingRaw>[0]));
    }
  }

  for (const meta of CLIENT_TRACKED_STABLECOINS) {
    const id = meta.id;
    const lifecycle = (meta.status ?? "active") as MergedRow["lifecycle"];
    if (lifecycle !== "active") continue;
    if (meta.flags.pegCurrency !== "USD") continue;

    const safety = reportById.get(id);
    const dews = dewsById.get(id);
    const dex = args.dexData?.[id];
    const yieldEntry = yieldById.get(id);
    const bluechip = args.bluechipData?.[id];

    const row: MergedRow = {
      id,
      symbol: meta.symbol,
      name: meta.name,
      protocolSlug: null,
      variantOf: meta.variantOf ?? null,
      isYieldBearing: Boolean(meta.flags.yieldBearing),
      pegCurrency: meta.flags.pegCurrency,
      lifecycle,
      governance: meta.flags.governance,
      canBeBlacklisted: meta.canBeBlacklisted ?? null,
      mechanismArchetype: meta.mechanismArchetype ?? null,

      supplyUsd: supplyById.get(id) ?? 0,

      pegScore: pegById.get(id) ?? null,
      pegStabilityScore: safety?.dimensions.pegStability.score ?? null,
      activeDepeg: dews?.activeDepeg ?? false,
      // currentDeviationBps stays null → engine treats as data-unavailable.
      // depegEventCount + lastEventAt come from depeg-events ingestion which
      // the slim client hooks do not yet expose; documented limitation, see
      // §11 of the implementation plan ("MergedRow half-null" residual gap).
      currentDeviationBps: null,
      depegEventCount: 0,
      lastEventAt: null,

      dewsScore: dews?.score ?? null,
      safetyGrade: (safety?.overallGrade ?? null) as MergedRow["safetyGrade"],
      safetyScore: safety?.overallScore ?? null,
      safetyResilienceScore: safety?.dimensions.resilience.score ?? null,
      safetyDependencyRiskScore: safety?.dimensions.dependencyRisk.score ?? null,
      safetyDecentralizationScore: safety?.dimensions.decentralization.score ?? null,
      safetyLiquidityScore: safety?.dimensions.liquidity.score ?? null,
      collateralQuality: null,
      custodyModel: null,
      bluechipGrade: (bluechip?.grade ?? null) as MergedRow["bluechipGrade"],

      liquidityScore: dex?.liquidityScore ?? null,
      effectiveTvlUsd: dex?.effectiveTvlUsd ?? null,
      concentrationHhi: dex?.concentrationHhi ?? null,
      chainTvl: dex?.chainTvl ?? {},
      effectiveExitScore: dex?.effectiveExitScore ?? null,

      pharosYieldScore: yieldEntry?.pharosYieldScore ?? null,
      apy30d: yieldEntry?.apy30d ?? null,
      apyVariance30d: null,
      benchmarkRate: null,
      sourceRiskScore: null,
      venueRiskTier: yieldEntry?.source?.sourceRiskTier ?? null,
      warningSignals: [],
      deploymentPlace: null,
      sourceSwitch: false,
      yieldProtocolSlug: yieldEntry?.source?.protocol ?? null,
      yieldVenueChain: yieldEntry?.source?.chain ?? null,
      yieldHistoryDays: 0,
      yieldFreshness: null,

      trackingSpanDays: 0,
      isRecentListing: false,
      pegSummaryAgeSec: null,
      dexTvlAgeSec: null,
      dewsAgeSec: null,
    };
    rows.set(id, row);
  }

  // Content-addressed dataset hash: SHA-256-ish digest over the canonical
  // serialization of the merged-universe content fields (id + scores + grades).
  // Two clients viewing the same producer snapshot must produce the same hash;
  // we therefore exclude any `dataUpdatedAt` / `ageSeconds` style fields.
  const datasetContent = Array.from(rows.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, row]) => ({
      id,
      safetyGrade: row.safetyGrade,
      overallScore: row.safetyScore,
      pegScore: row.pegScore,
      dewsScore: row.dewsScore,
      liquidityScore: row.liquidityScore,
      safetyPegStabilityScore: row.pegStabilityScore,
      safetyResilienceScore: row.safetyResilienceScore,
      safetyDependencyRiskScore: row.safetyDependencyRiskScore,
      safetyDecentralizationScore: row.safetyDecentralizationScore,
      safetyLiquidityScore: row.safetyLiquidityScore,
      pharosYieldScore: row.pharosYieldScore,
      apy30d: row.apy30d,
      bluechipGrade: row.bluechipGrade,
      supplyUsd: row.supplyUsd,
    }));
  const datasetHash = djb2Hex(canonicalizeForDatasetHash(datasetContent));

  // Methodology versions: read what's exposed on the response envelope. Only
  // `/api/report-cards` carries it on the typed response today (per Step-4
  // adversarial review residual gap); others fall back to `"unversioned"`
  // until the M0 worker precursors are completed for those endpoints.
  const safetyScoreVersion = args.reportData?.methodology?.version ?? "unversioned";

  return {
    rows,
    timestamp: args.now,
    datasetHash,
    methodologyVersions: {
      safetyScore: safetyScoreVersion,
      pegScoreAndDews: "unversioned",
      yieldIntelligence: "unversioned",
      bluechipAlignment: "unversioned",
      exclusionFilters: "selector-v1.0",
    },
  };
}

/**
 * Stable 32-bit djb2 hash → 8-char hex. Pure CPU, no async, no Web Crypto;
 * used for the dataset content hash that needs to be byte-identical across
 * clients. Collision odds for our universe (~270 coins × dataset variants)
 * are immaterial because the hash is a memoization key, not a cryptographic
 * primitive. The snapshot `sid` uses real SHA-256 server-side.
 */
function djb2Hex(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// Re-export to satisfy the import surface used by `client.test.tsx`.
export { decodeSelectorState, highestValidStep };
