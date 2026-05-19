"use client";

import { useState } from "react";
import { ArrowRight, Link as LinkIcon, Pencil } from "lucide-react";
import Link from "next/link";
import type { SelectorProfile, SelectorInput, SkippedCoin } from "@shared/lib/selector";
import { SelectorSkippedDisclosure } from "@/components/selector/selector-skipped-disclosure";
import { cn } from "@/lib/utils";

interface SelectorResultSummaryProps {
  profile: SelectorProfile;
  input: SelectorInput;
  universe: { active: number; surviving: number };
  shortlistCount: number;
  screenerHandoffHref: string;
  onAdjust: () => void;
  onCopyShareLink: () => Promise<void>;
  copyShareDisabled: boolean;
  copyShareDisabledReason?: string;
  skipped: readonly SkippedCoin[];
  // Layout slot for the snapshot banner.
  snapshotBanner?: React.ReactNode;
  // Mobile-only: order-aware reorder happens via Tailwind on the parent.
}

const PROFILE_LABEL: Record<SelectorProfile, string> = {
  treasury: "Treasury",
  yield: "Yield",
  trading: "Active Trading",
};

const HORIZON_LABEL: Record<SelectorInput["horizon"], string> = {
  lt24h: "under 24h",
  "1to7d": "1–7 days",
  "1to4w": "1–4 weeks",
  "1to6m": "1–6 months",
  "6mplus": "6 months+",
};

export function SelectorResultSummary(props: SelectorResultSummaryProps) {
  const {
    profile,
    input,
    universe,
    shortlistCount,
    screenerHandoffHref,
    onAdjust,
    onCopyShareLink,
    copyShareDisabled,
    copyShareDisabledReason,
    skipped,
    snapshotBanner,
  } = props;

  const [shareState, setShareState] = useState<"idle" | "pending" | "copied" | "error">("idle");
  const [shareError, setShareError] = useState<string | null>(null);

  const handleCopy = async () => {
    if (copyShareDisabled || shareState === "pending") return;
    setShareState("pending");
    setShareError(null);
    try {
      await onCopyShareLink();
      setShareState("copied");
      window.setTimeout(() => setShareState("idle"), 2500);
    } catch (err) {
      setShareError(err instanceof Error ? err.message : "Failed to create share link");
      setShareState("error");
    }
  };

  return (
    <section aria-labelledby="selector-summary" className="space-y-4">
      <div className="pharos-subtle-band space-y-3 rounded-2xl border border-border/55 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border/65 bg-background/60 px-2.5 py-1 text-xs font-medium text-foreground">
            {PROFILE_LABEL[profile]}
          </span>
          <span className="text-muted-foreground">·</span>
          <span className="text-xs text-muted-foreground">
            Horizon: {HORIZON_LABEL[input.horizon]}
          </span>
        </div>

        <h2 id="selector-summary" className="text-base font-semibold tracking-tight text-foreground sm:text-lg">
          {universe.active.toLocaleString()} tracked → {universe.surviving.toLocaleString()} filtered → {shortlistCount} picks
        </h2>

        <p className="pharos-page-title text-base font-extrabold leading-snug tracking-tight text-foreground sm:text-lg">
          This is filter output, not advice.
        </p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          A &ldquo;fit&rdquo; means the coin passed Pharos&rsquo;s exclusion filters for the profile and ranked highest on the scoring weights. Pharos surfaces analytical readings; allocation decisions are yours alone, made against your own counsel.
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
            className={cn(
              "pharos-focus-ring inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full border border-border/65 px-3.5 text-sm font-medium hover:bg-background/85 sm:min-h-9",
              copyShareDisabled || shareState === "pending"
                ? "cursor-not-allowed border-border/35 bg-background/35 text-muted-foreground"
                : "bg-background/60 text-foreground",
            )}
          >
            <LinkIcon className="h-3.5 w-3.5" aria-hidden="true" />
            {shareState === "pending"
              ? "Creating link…"
              : shareState === "copied"
                ? "Link copied"
                : "Copy share link"}
          </button>
        </div>

        {copyShareDisabled && copyShareDisabledReason ? (
          <p className="text-xs text-amber-700 dark:text-amber-200">{copyShareDisabledReason}</p>
        ) : null}
        {shareError ? <p className="text-xs text-destructive">{shareError}</p> : null}
      </div>

      {snapshotBanner}

      {skipped.length > 0 ? <SelectorSkippedDisclosure coins={skipped} /> : null}
    </section>
  );
}
