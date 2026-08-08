"use client";

import { useState } from "react";
import { ChevronDown, ExternalLink, LockKeyhole } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { StablecoinSafetyScoreV9AccessRow } from "@/lib/stablecoin-safety-score-v9-presentation";
import type { TransferReviewDeployment, TransferReviewView } from "@/lib/transfer-review";
import { DETAIL_MODULE_TITLE_CLASS } from "@/components/stablecoin-detail/section-title-class";

function DeploymentEvidence({ deployment }: { deployment: TransferReviewDeployment }) {
  return (
    <li>
      <div className="flex items-baseline justify-between gap-2">
        <p className="min-w-0 truncate text-xs font-medium text-foreground">
          {deployment.chainName}
          <span className="ml-1.5 font-normal text-muted-foreground">{deployment.scopeLabel}</span>
        </p>
        <Badge
          variant="outline"
          className="h-5 shrink-0 rounded-full border-border/60 bg-muted/40 px-2 text-[10px] font-medium text-muted-foreground"
        >
          {deployment.postureLabel}
        </Badge>
      </div>
      <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{deployment.evidence}</p>
      {deployment.sources.length > 0 ? (
        <ul className="mt-1 space-y-0.5">
          {deployment.sources.map((source) => (
            <li key={source.url}>
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="pharos-focus-ring inline-flex items-baseline gap-1 rounded-sm text-[11px] text-frost-blue underline-offset-2 hover:underline"
              >
                <ExternalLink className="h-3 w-3 shrink-0 translate-y-0.5" aria-hidden="true" />
                {source.label}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * The four scored access-posture enums, and — when a transfer review exists —
 * the per-deployment evidence behind them. Lives in the summary rail at `xl+`
 * and inside the Safety Score card below `xl`, the same split `#price` uses, so
 * the rail's absence on narrow viewports does not lose the rows.
 *
 * Every rated asset publishes at least two of the four (253 of 336 publish all
 * four), so this is always-present content rather than an occasional block. The
 * evidence disclosure is the citation for the strongest claim on the page:
 * whether anyone can stop a holder from transferring.
 */
export function AccessPosturePanel({
  rows,
  review = null,
  compact = false,
}: {
  rows: readonly StablecoinSafetyScoreV9AccessRow[];
  review?: TransferReviewView | null;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;

  const list = (
    <dl className="space-y-1">
      {rows.map((row) => (
        <div key={row.key} className="flex items-baseline justify-between gap-3 text-xs">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="text-right font-mono text-foreground">{row.value}</dd>
        </div>
      ))}
    </dl>
  );

  const evidence = review === null
    ? null
    : (
      <>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="pharos-focus-ring mt-2 inline-flex min-h-7 items-center gap-1 rounded-sm text-[11px] font-medium text-frost-blue"
        >
          {open
            ? "Show less"
            : `How this was verified · ${review.deployments.length} ${review.deployments.length === 1 ? "deployment" : "deployments"}`}
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} aria-hidden="true" />
        </button>
        {open ? (
          <div className="mt-2 border-t border-border/50 pt-3">
            {review.mixedPosture ? (
              <p className="mb-2 text-[11px] leading-snug text-amber-700 dark:text-amber-400">
                Posture differs by chain. The rows above summarise the strictest.
              </p>
            ) : null}
            <ul className="space-y-3">
              {review.deployments.map((deployment) => (
                <DeploymentEvidence key={deployment.key} deployment={deployment} />
              ))}
            </ul>
            <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              Reviewed {review.reviewedAt}
            </p>
          </div>
        ) : null}
      </>
    );

  if (compact) {
    return (
      <section className="pharos-card-shell overflow-hidden" aria-label="Access posture">
        <div className="flex items-center justify-between gap-3 px-4 py-3.5">
          <h2 className={DETAIL_MODULE_TITLE_CLASS}>Access posture</h2>
          <LockKeyhole className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </div>
        <div className="px-4 pb-4">
          {list}
          {evidence}
        </div>
      </section>
    );
  }

  return (
    <section className="border-b border-border/40 pb-3 xl:hidden" aria-label="Access posture">
      <div className="flex items-center gap-2">
        <LockKeyhole className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <h3 className="text-sm font-semibold">Access posture</h3>
      </div>
      <div className="mt-1">
        {list}
        {evidence}
      </div>
    </section>
  );
}
