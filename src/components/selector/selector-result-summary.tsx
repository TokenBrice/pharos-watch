"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Link as LinkIcon,
  Pencil,
  RotateCcw,
} from "lucide-react";
import Link from "next/link";
import type { SelectorInput, SelectorProfile } from "@shared/lib/selector";
import { PEG_METADATA } from "@shared/lib/classification";
import {
  selectorExclusionReasonLabel,
  selectorProfileLabel,
} from "@shared/lib/selector/selector-labels";
import { SelectorEmblem } from "@/components/home-alt-callouts/selector-emblem";
import { cn } from "@/lib/utils";

export interface SelectorSummaryCoverageWarnings {
  sparse?: boolean;
  uneven?: boolean;
  skippedForCoverageCount?: number;
}

export interface SelectorSummaryFilterChip {
  label: string;
  value: string;
}

export interface SelectorSummaryAnswerChip {
  key: string;
  label: string;
  value: string;
}

export interface SelectorSummarySessionRecovery {
  message: string;
  onRestore: () => void;
  onDismiss?: () => void;
}

export interface SelectorResultSummaryProps {
  profile: SelectorProfile;
  input: SelectorInput;
  universe: { active: number; surviving: number };
  shortlistCount: number;
  screenerHandoffHref: string;
  summaryHeadingRef?: React.Ref<HTMLHeadingElement>;
  onAdjust: () => void;
  onEditAnswer?: (key: string) => void;
  onCopyShareLink: () => Promise<void>;
  copyShareDisabled: boolean;
  copyShareDisabledReason?: string;
  shareFallbackUrl?: string;
  lowConfidence?: boolean;
  coverageWarnings?: SelectorSummaryCoverageWarnings;
  usedRelaxedFallback?: boolean;
  relaxedReasons?: readonly string[];
  filterChips?: readonly SelectorSummaryFilterChip[];
  answerChips?: readonly SelectorSummaryAnswerChip[];
  priorityLabels?: readonly string[];
  sessionRecovery?: SelectorSummarySessionRecovery;
  // Forward-action slot rendered directly under the funnel headline so the next
  // step (Compare these / Compare vs watch-outs) sits above secondary prose
  // rather than below the answer-chip and share-link blocks.
  compareActionsSlot?: ReactNode;
  // Mobile-only: order-aware reorder happens via Tailwind on the parent.
}

const HORIZON_LABEL: Record<SelectorInput["horizon"], string> = {
  lt24h: "under 24h",
  "1to7d": "1-7 days",
  "1to4w": "1-4 weeks",
  "1to6m": "1-6 months",
  "6mplus": "6 months+",
};

export function SelectorResultSummary(props: SelectorResultSummaryProps) {
  const {
    profile,
    input,
    universe,
    shortlistCount,
    screenerHandoffHref,
    summaryHeadingRef,
    onAdjust,
    onEditAnswer,
    onCopyShareLink,
    copyShareDisabled,
    copyShareDisabledReason,
    shareFallbackUrl,
    lowConfidence = false,
    coverageWarnings,
    usedRelaxedFallback = false,
    relaxedReasons = [],
    filterChips = [],
    answerChips = [],
    priorityLabels = [],
    sessionRecovery,
    compareActionsSlot,
  } = props;

  const [shareState, setShareState] = useState<"idle" | "pending" | "copied" | "error">("idle");
  const [shareError, setShareError] = useState<string | null>(null);
  const shareResetTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const shareDescriptionId = useId();
  const shareStatusId = useId();
  const shareErrorId = useId();
  const disabledReasonId = useId();
  const pegLabel = PEG_METADATA[input.pegCurrency]?.filterLabel ?? input.pegCurrency;
  const resultBanners = buildResultBanners({
    lowConfidence,
    coverageWarnings,
    usedRelaxedFallback,
    relaxedReasons,
  });
  const describedBy = [
    shareDescriptionId,
    shareStatusId,
    copyShareDisabled && copyShareDisabledReason ? disabledReasonId : null,
    shareError ? shareErrorId : null,
  ].filter(Boolean).join(" ");

  useEffect(() => () => {
    if (shareResetTimer.current) clearTimeout(shareResetTimer.current);
  }, []);

  const handleCopy = async () => {
    if (copyShareDisabled || shareState === "pending") return;
    if (shareResetTimer.current) clearTimeout(shareResetTimer.current);
    setShareState("pending");
    setShareError(null);
    try {
      await onCopyShareLink();
      setShareState("copied");
      shareResetTimer.current = setTimeout(() => setShareState("idle"), 2500);
    } catch (err) {
      setShareError(err instanceof Error ? err.message : "Failed to create share link");
      setShareState("error");
    }
  };

  return (
    <section aria-labelledby="selector-summary" className="space-y-4">
      {sessionRecovery ? (
        <div
          role="status"
          className="flex flex-col gap-2 rounded-lg border border-frost-blue/35 bg-frost-blue/[0.06] px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="text-foreground">{sessionRecovery.message}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={sessionRecovery.onRestore}
              className="pharos-focus-ring inline-flex min-h-10 items-center gap-1.5 rounded-full border border-frost-blue/45 px-3 text-xs font-medium text-foreground hover:bg-frost-blue/[0.1]"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              Restore result
            </button>
            {sessionRecovery.onDismiss ? (
              <button
                type="button"
                onClick={sessionRecovery.onDismiss}
                className="pharos-focus-ring inline-flex min-h-10 items-center rounded-full border border-border/55 px-3 text-xs font-medium text-foreground hover:bg-muted/35"
              >
                Dismiss
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="pharos-subtle-band space-y-3 rounded-2xl border border-border/55 p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center text-[color:oklch(0.62_0.24_330)]"
          >
            <SelectorEmblem />
          </span>
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border/65 bg-background/60 px-2.5 py-1 text-xs font-medium text-foreground">
                {selectorProfileLabel(profile)}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border/65 bg-background/60 px-2.5 py-1 text-xs font-medium text-foreground">
                {pegLabel} peg
              </span>
              <span className="text-muted-foreground">·</span>
              <span className="text-xs text-muted-foreground">
                Horizon: {HORIZON_LABEL[input.horizon]}
              </span>
            </div>

            <h2
              id="selector-summary"
              ref={summaryHeadingRef}
              tabIndex={-1}
              className="text-base font-semibold tracking-tight text-foreground outline-none sm:text-lg"
            >
              <span className="font-mono tabular-nums">{universe.active.toLocaleString()}</span> tracked {pegLabel} stablecoins → <span className="font-mono tabular-nums">{universe.surviving.toLocaleString()}</span> filtered → <span className="font-mono tabular-nums">{shortlistCount}</span> shortlist entries
            </h2>
          </div>
        </div>

        {compareActionsSlot ? (
          <div className="flex flex-col gap-2 pt-0.5 sm:flex-row sm:flex-wrap">{compareActionsSlot}</div>
        ) : null}

        <p className="text-xs leading-relaxed text-muted-foreground">
          Filter output, not advice. A &ldquo;fit&rdquo; passed Pharos&rsquo;s exclusion filters for the selected peg and profile, then ranked highest on the scoring weights.
        </p>

        {resultBanners.length > 0 ? (
          <div className="space-y-2" aria-label="Result quality notices">
            {resultBanners.map((banner) => (
              <div
                key={banner.title}
                role="status"
                className={cn(
                  "flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm",
                  banner.tone === "amber"
                    ? "border-amber-500/35 bg-amber-500/[0.07] text-amber-950 dark:text-amber-100"
                    : "border-frost-blue/35 bg-frost-blue/[0.06] text-foreground",
                )}
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <p>
                  <span className="font-semibold">{banner.title}</span>{" "}
                  <span>{banner.message}</span>
                </p>
              </div>
            ))}
          </div>
        ) : null}

        {answerChips.length > 0 || priorityLabels.length > 0 ? (
          <div className="grid gap-3 rounded-lg border border-border/50 bg-background/35 p-3 md:grid-cols-[1fr_auto]">
            {answerChips.length > 0 ? (
              <div className="min-w-0 space-y-2">
                <p className="pharos-kicker">Answers</p>
                <div className="flex flex-wrap gap-2">
                  {answerChips.map((chip) => (
                    <button
                      key={chip.key}
                      type="button"
                      aria-label={`Edit ${chip.label.toLowerCase()}: ${chip.value}`}
                      onClick={() => (onEditAnswer ? onEditAnswer(chip.key) : onAdjust())}
                      className="pharos-focus-ring inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/65 bg-card/55 px-2.5 py-1 text-xs font-medium text-foreground hover:bg-card"
                    >
                      <span className="shrink-0 text-muted-foreground">{chip.label}:</span>
                      <span className="min-w-0 break-words">{chip.value}</span>
                      <Pencil className="h-3 w-3 shrink-0" aria-hidden="true" />
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {priorityLabels.length > 0 ? (
              <div className="min-w-0 space-y-2 md:max-w-xs">
                <p className="pharos-kicker">Prioritized</p>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {priorityLabels.join(", ")}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}

        {filterChips.length > 0 ? (
          <div className="space-y-2 rounded-lg border border-dashed border-border/45 bg-background/25 p-3">
            <div className="space-y-2">
              <p className="pharos-kicker">Screener handoff filters</p>
              <div className="flex flex-wrap gap-1.5">
                {filterChips.map((chip) => (
                  <span
                    key={`${chip.label}:${chip.value}`}
                    className="inline-flex max-w-full items-baseline gap-0 rounded-md border border-border/45 bg-card/35 font-mono text-[11px]"
                  >
                    <span className="shrink-0 px-1.5 py-0.5 text-muted-foreground">{chip.label}</span>
                    <span className="border-l border-border/45 px-1.5 py-0.5 text-foreground">{chip.value}</span>
                  </span>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        <p id={shareDescriptionId} className="text-xs leading-relaxed text-muted-foreground">
          Share links store these answers and this output for up to 5 years. Anyone with the link can view them.
        </p>

        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-3">
          <button
            type="button"
            onClick={onAdjust}
            className="pharos-focus-ring inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full border border-border/65 bg-background/60 px-3.5 text-sm font-medium text-foreground hover:bg-background/85 sm:min-h-9"
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            Adjust answers
          </button>
          <Link
            href={screenerHandoffHref}
            className="pharos-focus-ring inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full border border-border/65 bg-background/60 px-3.5 text-sm font-medium text-foreground hover:bg-background/85 sm:min-h-9"
          >
            Verify in Screener
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
          <button
            type="button"
            onClick={handleCopy}
            disabled={copyShareDisabled || shareState === "pending"}
            aria-disabled={copyShareDisabled || shareState === "pending"}
            aria-describedby={describedBy}
            className={cn(
              "pharos-focus-ring inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full border border-border/65 px-3.5 text-sm font-medium hover:bg-background/85 sm:min-h-9",
              copyShareDisabled || shareState === "pending"
                ? "cursor-not-allowed border-border/35 bg-background/35 text-muted-foreground"
                : "bg-background/60 text-foreground",
            )}
          >
            <LinkIcon className="h-3.5 w-3.5" aria-hidden="true" />
            {shareState === "pending"
              ? "Creating link..."
              : shareState === "copied"
                ? "Link copied"
                : "Copy share link"}
          </button>
        </div>

        {copyShareDisabled && copyShareDisabledReason ? (
          <p id={disabledReasonId} role="alert" className="text-xs text-amber-700 dark:text-amber-200">
            {copyShareDisabledReason}
          </p>
        ) : null}
        <p id={shareStatusId} role="status" aria-live="polite" className="sr-only">
          {shareState === "pending"
            ? "Creating share link."
            : shareState === "copied"
              ? "Share link copied."
              : ""}
        </p>
        {shareError ? (
          <div id={shareErrorId} role="alert" className="space-y-1 text-xs text-destructive">
            <p>{shareError}</p>
            {shareFallbackUrl ? (
              <label className="block space-y-1 text-muted-foreground">
                <span>Copy this link manually if clipboard access is blocked.</span>
                <input
                  readOnly
                  value={shareFallbackUrl}
                  className="pharos-focus-ring w-full rounded-md border border-border/60 bg-background px-2 py-1 font-mono text-[11px] text-foreground"
                  onFocus={(event) => event.currentTarget.select()}
                />
              </label>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function buildResultBanners({
  lowConfidence,
  coverageWarnings,
  usedRelaxedFallback,
  relaxedReasons,
}: {
  lowConfidence: boolean;
  coverageWarnings?: SelectorSummaryCoverageWarnings;
  usedRelaxedFallback: boolean;
  relaxedReasons: readonly string[];
}): Array<{ title: string; message: string; tone: "amber" | "blue" }> {
  const banners: Array<{ title: string; message: string; tone: "amber" | "blue" }> = [];
  if (lowConfidence) {
    banners.push({
      title: "Low-confidence shortlist.",
      message: "Fit quality is below the normal threshold; treat the ordering as a starting point for review.",
      tone: "amber",
    });
  }
  if (coverageWarnings?.sparse) {
    banners.push({
      title: "Sparse coverage.",
      message: "A large share of this peg universe lacks enough live data for the selected profile.",
      tone: "amber",
    });
  } else if (coverageWarnings?.uneven) {
    banners.push({
      title: "Uneven coverage.",
      message: "Some coins were skipped because one or more required live signals are missing.",
      tone: "amber",
    });
  }
  if (usedRelaxedFallback) {
    banners.push({
      title: "Relaxed fallback used.",
      message:
        relaxedReasons.length > 0
          ? `No clean fit survived, so Pharos relaxed: ${relaxedReasons.map(readableRelaxedReason).join(", ")}.`
          : "No clean fit survived, so Pharos widened one or more soft constraints.",
      tone: "amber",
    });
  }
  return banners;
}

function readableRelaxedReason(reason: string): string {
  return selectorExclusionReasonLabel(reason) ?? reason.replace(/-/g, " ");
}
