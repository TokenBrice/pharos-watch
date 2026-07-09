"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  getTemplate,
  type SelectorInput,
  type SelectorOutput,
  type SelectorRecommendation,
} from "@shared/lib/selector";
import { selectorComponentReadingLabel } from "@shared/lib/selector/selector-labels";
import { formatScoreTrimmed as formatScore } from "@shared/lib/format";
import { Bot, ExternalLink } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyButton } from "@/components/copy-button";
import { useLogos } from "@/hooks/use-logos";
import { useYieldRankings } from "@/hooks/api-hooks";
import { SelectorResultSummary } from "@/components/selector/selector-result-summary";
import { SelectorShortlistCard } from "@/components/selector/selector-shortlist-card";
import { SelectorLowerRankedRow } from "@/components/selector/selector-lower-ranked-row";
import {
  SelectorEmptyState,
  readableFailingDimension,
  type SelectorClosestSurvivor,
  type SelectorRelaxableConstraint,
} from "@/components/selector/selector-empty-state";
import { SelectorSkippedDisclosure } from "@/components/selector/selector-skipped-disclosure";
import { SelectorSnapshotBanner } from "@/components/selector/selector-snapshot-banner";
import type { SelectorProfile, SelectorStep, SelectorWizardState } from "./selector-state";
import { PROFILE_LABEL } from "./picker-options";
import {
  buildCompareShortlistHref,
  buildCompareWithWatchoutsHref,
  buildResultSummaryCoordinationProps,
  buildScreenerHandoff,
  buildYieldInspectionHref,
  stepForAnswerKey,
} from "./handoff";
import type { UseSelectorResult } from "./use-selector";
import { PHAROSWATCHBOT_BOT_URL } from "@/app/pharoswatchbot/telegram-route-constants";

export interface ResultPaneProps {
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

export function ResultPane({
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
  const yieldRankings = useYieldRankings();
  const yieldSourceUrls = useMemo(() => {
    const map = new Map<string, string>();
    for (const ranking of yieldRankings.data?.rankings ?? []) {
      const primaryKey = ranking.provenance?.sourceKey;
      if (primaryKey && ranking.yieldSourceUrl) {
        map.set(`${ranking.id}::${primaryKey}`, ranking.yieldSourceUrl);
      }
      for (const alt of ranking.altSources ?? []) {
        if (alt.yieldSourceUrl) {
          map.set(`${ranking.id}::${alt.sourceKey}`, alt.yieldSourceUrl);
        }
      }
    }
    return map;
  }, [yieldRankings.data]);
  const resultFocusRef = useRef<HTMLDivElement>(null);
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  const shortlistHeadingRef = useRef<HTMLHeadingElement>(null);
  const [showSnapshotComparison, setShowSnapshotComparison] = useState(false);

  const outputForFocus = "output" in selectorResult ? selectorResult.output : null;
  useEffect(() => {
    if (!outputForFocus) return;
    const frame = requestAnimationFrame(() => {
      const target = outputForFocus.recommended.length > 0 ? resultHeadingRef.current : resultFocusRef.current;
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [selectorResult.status, outputForFocus]);

  if (selectorResult.status === "loading" || selectorResult.status === "snapshot-loading") {
    return (
      <div className="space-y-4" aria-busy="true" aria-live="polite">
        <p className="sr-only">Picker result is loading.</p>
        <Skeleton className="h-32 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  if (selectorResult.status === "error") {
    return (
      <div
        role="alert"
        className="space-y-3 rounded-lg border border-destructive/40 bg-destructive/[0.08] px-4 py-3 text-sm text-destructive"
      >
        <p>Selector could not produce a result ({humanizeSelectorError(selectorResult.reason)}).</p>
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
  const yieldInspectionHref = buildYieldInspectionHref(output);
  const telegramSubscribeCommand = buildTelegramSubscribeCommand(output.recommended);
  const liveComparisonOutput = selectorResult.status === "snapshot-found" ? selectorResult.liveOutput : null;
  const snapshotBanner =
    selectorResult.status === "snapshot-found" ? (
      <SelectorSnapshotBanner
        mode="frozen"
        trust={output.provenance === "pharos-verified" ? "verified" : "unverified"}
        capturedAt={output.timestamp}
        onCompareToToday={() => setShowSnapshotComparison(true)}
      />
    ) : selectorResult.status === "snapshot-miss" ? (
      <SelectorSnapshotBanner mode="fallback" />
    ) : null;

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

  const singleResult = output.recommended.length === 1;
  const showCompareShortlist = output.recommended.length > 1;

  return (
    <div ref={resultFocusRef} tabIndex={-1} className="flex flex-col gap-6 outline-none">
      {snapshotBanner}

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
        lowConfidence={output.lowConfidence}
        coverageWarnings={output.coverageWarnings}
        compareActionsSlot={
          showCompareShortlist || output.lowerRanked.length > 0 || yieldInspectionHref ? (
            <>
              {yieldInspectionHref ? (
                <YieldInspectionAction href={yieldInspectionHref} primary={!showCompareShortlist} />
              ) : null}
              {showCompareShortlist ? <CompareShortlistAction href={compareShortlistHref} /> : null}
              {output.lowerRanked.length > 0 ? <CompareWatchoutsAction href={compareWatchoutsHref} /> : null}
            </>
          ) : undefined
        }
        {...buildResultSummaryCoordinationProps({
          output,
          state,
          screenerHandoff,
        })}
      />

      <TelegramSubscribeCommand command={telegramSubscribeCommand} />

      {sessionRecovered ? <SessionRecoveredBanner /> : null}

      {showSnapshotComparison ? (
        <SnapshotComparisonPanel
          frozen={output}
          live={liveComparisonOutput}
          liveStatus={selectorResult.status === "snapshot-found" ? selectorResult.liveStatus : "unavailable"}
        />
      ) : null}

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
            const sourceKey = rec.profile === "yield" ? rec.recommendedSource?.sourceKey : null;
            const yieldSourceUrl = sourceKey ? (yieldSourceUrls.get(`${rec.id}::${sourceKey}`) ?? null) : null;
            const yieldInspectionHref = rec.profile === "yield" ? `/stablecoin/${rec.id}/yield/` : null;
            return (
              <SelectorShortlistCard
                key={rec.id}
                rank={(idx + 1) as 1 | 2 | 3}
                recommendation={enriched}
                profile={profile}
                isMobile={isMobile}
                logoUrl={logos[rec.id] ?? undefined}
                prominentOpenDetail={singleResult}
                yieldSourceUrl={yieldSourceUrl}
                yieldInspectionHref={yieldInspectionHref}
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
              <SelectorLowerRankedRow key={entry.id} entry={entry} pegCurrency={effectiveInput.pegCurrency} />
            ))}
          </ol>
        </section>
      ) : null}

      <div className="space-y-2">
        <NearMissesDisclosure survivors={buildClosestSurvivorsFromOutput(output)} />
        {output.coverageWarnings.skippedForCoverage.length > 0 ? (
          <SelectorSkippedDisclosure coins={output.coverageWarnings.skippedForCoverage} />
        ) : null}
      </div>

      <footer className="space-y-2 border-t border-border/55 pt-4 text-xs leading-relaxed text-muted-foreground">
        <p>
          Picker output uses {summarizeMethodologyVersions(output.methodologyVersions)} against dataset snapshot{" "}
          <code>{output.datasetHash}</code>. Not personalized financial advice. Does not account for jurisdiction, tax,
          counterparty agreements, or operational constraints not captured by the form.{" "}
          <em>Historical readings; future behaviour may differ.</em>
        </p>
      </footer>
    </div>
  );
}

export function SessionRecoveredBanner() {
  return (
    <div
      role="status"
      className="rounded-lg border border-frost-blue/35 bg-frost-blue/[0.06] px-4 py-3 text-sm text-foreground"
    >
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

function YieldInspectionAction({ href, primary }: { href: string; primary: boolean }) {
  return (
    <a
      href={href}
      className={
        primary
          ? "pharos-focus-ring inline-flex min-h-10 items-center justify-center rounded-full border border-foreground/60 bg-foreground px-3 text-sm font-medium text-background hover:bg-foreground/90"
          : "pharos-focus-ring pharos-control-pill min-h-10 px-3 text-sm"
      }
    >
      Inspect on Yield Intelligence
    </a>
  );
}

function CompareWatchoutsAction({ href }: { href: string }) {
  return (
    <a href={href} className="pharos-focus-ring pharos-control-pill min-h-10 px-3 text-sm">
      Compare shortlist vs watch-outs
    </a>
  );
}

function TelegramSubscribeCommand({ command }: { command: string }) {
  return (
    <section aria-labelledby="selector-telegram-command-heading" className="pharos-card-shell p-4 sm:p-5">
      <div className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background/60 text-muted-foreground">
              <Bot className="h-4 w-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="pharos-kicker">Telegram follow command</p>
              <h2
                id="selector-telegram-command-heading"
                className="text-sm font-semibold tracking-tight text-foreground"
              >
                Follow this shortlist in PharosWatchBot
              </h2>
            </div>
          </div>
          <a
            href={PHAROSWATCHBOT_BOT_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="pharos-focus-ring inline-flex min-h-10 shrink-0 items-center justify-center gap-1.5 rounded-full border border-foreground/60 bg-foreground px-3.5 text-sm font-medium text-background hover:bg-foreground/90"
          >
            Open PharosWatchBot
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </div>
        <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-background/85 px-3 py-2.5 shadow-[inset_0_1px_0_oklch(1_0_0_/_0.04)]">
          <span aria-hidden="true" className="font-mono text-sm font-semibold text-muted-foreground">
            ▸
          </span>
          <code className="block min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[13px] font-medium text-foreground sm:text-sm">
            {command}
          </code>
          <CopyButton
            text={command}
            className="size-8 shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground"
          />
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Copies a Telegram command for DEWS, depeg, and safety alerts on the shortlisted stablecoins.
        </p>
      </div>
    </section>
  );
}

const TELEGRAM_TARGET_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const TELEGRAM_RESERVED_COMMAND_TOKENS = new Set([
  "all",
  "dews",
  "depeg",
  "depeg-step",
  "launch",
  "reserve",
  "safety",
  "usd-top10",
  "usd-top-10",
  "usd-top25",
  "usd-top-25",
  "usd-top50",
  "usd-top-50",
  "non-usd-top10",
  "non-usd-top-10",
  "non-usd-top25",
  "non-usd-top-25",
  "non-usd-top50",
  "non-usd-top-50",
  "eur-top10",
  "eur-top-10",
  "gold-top5",
  "gold-top-5",
  "mcap-ge-1b",
  "mcap-ge-100m",
]);

function buildTelegramSubscribeCommand(recommendations: readonly SelectorRecommendation[]): string {
  const targets = Array.from(new Set(recommendations.map((rec) => telegramTargetToken(rec)).filter(Boolean)));
  return `/subscribe dews, depeg, safety ${targets.join(", ")}`.trim();
}

function telegramTargetToken(rec: SelectorRecommendation): string | null {
  return safeTelegramTargetToken(rec.symbol) ?? safeTelegramTargetToken(rec.id);
}

function safeTelegramTargetToken(value: string): string | null {
  const token = value.trim();
  if (!TELEGRAM_TARGET_TOKEN_PATTERN.test(token)) return null;
  if (TELEGRAM_RESERVED_COMMAND_TOKENS.has(token.toLowerCase())) return null;
  return token;
}

function NearMissesDisclosure({ survivors }: { survivors: readonly SelectorClosestSurvivor[] }) {
  if (survivors.length === 0) return null;
  return (
    <details className="rounded-lg border border-border/55 bg-card/35 px-3 py-2 text-sm">
      <summary className="cursor-pointer font-medium text-foreground">Near misses / why not shown</summary>
      <ul className="mt-2 space-y-1.5 leading-relaxed">
        {survivors.map((survivor) => (
          <li key={survivor.id} className="text-muted-foreground">
            <span className="font-semibold text-foreground">{survivor.symbol}</span>
            <span>
              {" "}
              missed on {readableFailingDimension(survivor.failingDimension)}: {survivor.liveReading}
            </span>
            {survivor.hypotheticalScore != null ? (
              <span className="text-foreground"> Hypothetical score {formatScore(survivor.hypotheticalScore)}.</span>
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
      <div
        aria-busy="true"
        className="rounded-lg border border-border/55 bg-card/35 px-4 py-3 text-sm text-muted-foreground"
      >
        Loading current data comparison.
      </div>
    );
  }
  if (!live || liveStatus !== "ready") {
    return (
      <div
        role="status"
        className="rounded-lg border border-border/55 bg-card/35 px-4 py-3 text-sm text-muted-foreground"
      >
        Current comparison is unavailable for this snapshot.
      </div>
    );
  }
  const delta = compareSelectorOutputs(frozen, live);
  return (
    <section
      className="space-y-2 rounded-lg border border-border/55 bg-card/35 px-4 py-3 text-sm"
      aria-label="Current shortlist comparison"
    >
      <p className="font-semibold text-foreground">Current shortlist comparison</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <p className="text-muted-foreground">
          Added today: <span className="text-foreground">{delta.added || "none"}</span>
        </p>
        <p className="text-muted-foreground">
          Removed today: <span className="text-foreground">{delta.removed || "none"}</span>
        </p>
        <p className="text-muted-foreground">
          Rank/score movement: <span className="text-foreground">{delta.movements || "none"}</span>
        </p>
        <p className="text-muted-foreground">
          Dataset hash drift: <span className="text-foreground">{delta.datasetChanged ? "yes" : "no"}</span>
        </p>
        <p className="text-muted-foreground">
          Engine version drift: <span className="text-foreground">{delta.engineVersionChanged ? "yes" : "no"}</span>
        </p>
        <p className="text-muted-foreground">
          Methodology drift: <span className="text-foreground">{delta.methodologyChanged ? "yes" : "no"}</span>
        </p>
      </div>
    </section>
  );
}

function buildClosestSurvivorsFromOutput(output: SelectorOutput): SelectorClosestSurvivor[] {
  // closestSurvivors is a required field on SelectorOutput (and validated as a
  // required array when a snapshot is reconstructed), so it is always defined;
  // the coverage-warning fallback below stays for defensive runtime safety only.
  const fromEngine: readonly SelectorClosestSurvivor[] | undefined = output.closestSurvivors;
  if (fromEngine !== undefined) return fromEngine.slice(0, 3);
  return output.coverageWarnings.skippedForCoverage.slice(0, 3).map((coin) => ({
    id: coin.id,
    symbol: coin.symbol,
    failingDimension: coin.missingSignals[0] ?? "coverage gap",
    liveReading: "coverage signal unavailable",
  }));
}

function buildRelaxableConstraintsFromOutput(output: SelectorOutput): SelectorRelaxableConstraint[] {
  const fromEngine: readonly SelectorRelaxableConstraint[] | undefined = output.relaxableConstraints;
  return fromEngine ? fromEngine.slice(0, 3) : [];
}

function summarizeMethodologyVersions(versions: SelectorOutput["methodologyVersions"]): string {
  return `safety ${versions.safetyScore}, peg/DEWS ${versions.pegScoreAndDews}, yield ${versions.yieldIntelligence}, bluechip ${versions.bluechipAlignment}, exclusions ${versions.exclusionFilters}`;
}

function buildWhyText(rec: SelectorRecommendation): string {
  const strongest = rec.components
    .filter((component) => component.rawValue != null)
    .sort((a, b) => b.contribution - a.contribution)[0];
  if (strongest) {
    const componentLabel =
      selectorComponentReadingLabel(strongest.key) ?? strongest.key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
    return `${rec.symbol} ranked here because ${componentLabel} contributed ${strongest.contribution.toFixed(1)} points from a ${Math.round(strongest.rawValue ?? strongest.normalizedValue ?? 0)} reading.`;
  }
  return `${rec.symbol} passed the selected profile filters and ranked under the current ${PROFILE_LABEL[rec.profile]} weight set.`;
}

function humanizeSelectorError(reason: string): string {
  const labels: Record<string, string> = {
    offline: "you appear to be offline",
    "selector-data-unavailable": "required market data is temporarily unavailable",
    "snapshot-not-found": "snapshot not found",
    "snapshot-store-unavailable": "snapshot store unavailable",
    "snapshot-corrupt": "snapshot data is corrupt",
    "invalid-snapshot-id": "snapshot id is invalid",
    "engine-failed": "engine failed",
  };
  return labels[reason] ?? reason;
}

function compareSelectorOutputs(
  frozen: SelectorOutput,
  live: SelectorOutput,
): {
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
    methodologyChanged: JSON.stringify(frozen.methodologyVersions) !== JSON.stringify(live.methodologyVersions),
  };
}
