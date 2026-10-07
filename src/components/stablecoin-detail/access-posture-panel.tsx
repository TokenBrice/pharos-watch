"use client";

import type { ReactNode } from "react";
import { LockKeyhole } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  EvidenceFooter,
  type EvidenceFooterSource,
} from "@/components/stablecoin-detail/evidence-footer";
import { EvidenceModule } from "@/components/stablecoin-detail/evidence-module";
import { FactGrid } from "@/components/stablecoin-detail/fact-grid";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { RailCard } from "@/components/stablecoin-detail/rail-card";
import type { StablecoinSafetyScoreV9AccessRow } from "@/lib/stablecoin-safety-score-v9-presentation";
import type { TransferReviewDeployment, TransferReviewView } from "@/lib/transfer-review";

/**
 * The four scored access enums (`buildSafetyScoreV9AccessRows`). Every other
 * row the builder emits is a reserve-access look-through diagnostic.
 */
const SCORED_ACCESS_KEYS: Record<string, true> = {
  transfer: true,
  freezeExposure: true,
  primaryExit: true,
  governance: true,
};

const MIXED_POSTURE_NOTE = "Posture differs by chain. The scored values summarise the strictest.";

export type AccessPostureVariant = "rail" | "strip";

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
    </li>
  );
}

/**
 * The per-deployment citations, collected into the module-footer shape
 * `EvidenceFooter` expresses. Chain attribution moves into the label because
 * there is no per-item footer form and inventing one would be a second
 * disclosure idiom; identical label/url pairs collapse, since several
 * deployments legitimately cite the same registry page.
 */
function collectReviewSources(review: TransferReviewView): EvidenceFooterSource[] {
  const byKey = new Map<string, EvidenceFooterSource>();
  for (const deployment of review.deployments) {
    for (const source of deployment.sources) {
      const label = `${deployment.chainName} · ${source.label}`;
      const key = `${label}:${source.url}`;
      if (!byKey.has(key)) byKey.set(key, { label, url: source.url });
    }
  }
  return [...byKey.values()];
}

/** "How this was verified · N deployments": the per-chain evidence behind the enums. */
function VerificationDisclosure({ review, children }: { review: TransferReviewView; children?: ReactNode }) {
  const count = review.deployments.length;
  return (
    <ModuleDisclosure label={`How this was verified · ${count} ${count === 1 ? "deployment" : "deployments"}`}>
      <div className="mt-1 border-t border-border/50 pt-3">
        {review.mixedPosture ? (
          <p className="mb-2 text-[11px] leading-snug text-muted-foreground">{MIXED_POSTURE_NOTE}</p>
        ) : null}
        <ul className="space-y-3">
          {review.deployments.map((deployment) => (
            <DeploymentEvidence key={deployment.key} deployment={deployment} />
          ))}
        </ul>
        {children}
      </div>
    </ModuleDisclosure>
  );
}

/**
 * The scored access-posture enums and, when a transfer review exists, the
 * per-deployment evidence behind them.
 *
 * - `rail` (xl+): the compact rail card, every row as a label/value line.
 * - `strip` (the in-flow twin below xl, inside the Exit board): an evidence
 *   module in strip form — the four scored enums on one row of labelled
 *   cells, then the reserve-access diagnostics (when published), the
 *   verification fold, and the sources fold with the review date.
 *
 * Every rated asset publishes at least two of the four (253 of 336 publish all
 * four), so this is always-present content rather than an occasional block.
 * The verification fold is the citation for the strongest claim on the page:
 * whether anyone can stop a holder from transferring.
 */
export function AccessPosturePanel({
  rows,
  review = null,
  variant,
  compact = false,
  id,
  className,
}: {
  rows: readonly StablecoinSafetyScoreV9AccessRow[];
  review?: TransferReviewView | null;
  /** Defaults to `rail` when `compact`, otherwise `strip`. */
  variant?: AccessPostureVariant;
  /** Legacy spelling of `variant="rail"`. */
  compact?: boolean;
  /** Strip only: anchor id on the module. */
  id?: string;
  /** Strip only: lands on the module root, e.g. `xl:hidden` for the in-flow twin. */
  className?: string;
}) {
  if (rows.length === 0) return null;

  if ((variant ?? (compact ? "rail" : "strip")) === "rail") {
    return (
      <RailCard
        title="Access posture"
        ariaLabel="Access posture"
        trailing={<LockKeyhole className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
      >
        <div className="px-4 pb-4">
          <dl className="space-y-1">
            {rows.map((row) => (
              <div key={row.key} className="flex items-baseline justify-between gap-3 text-xs">
                <dt className="text-muted-foreground">{row.label}</dt>
                <dd className="text-right font-mono text-foreground">{row.value}</dd>
              </div>
            ))}
          </dl>
          {review === null ? null : (
            <div className="mt-1">
              <VerificationDisclosure review={review}>
                <EvidenceFooter
                  className="mt-3"
                  sources={collectReviewSources(review)}
                  reviewed={review.reviewedAt}
                />
              </VerificationDisclosure>
            </div>
          )}
        </div>
      </RailCard>
    );
  }

  const scored = rows.filter((row) => SCORED_ACCESS_KEYS[row.key] === true);
  const diagnostics = rows.filter((row) => SCORED_ACCESS_KEYS[row.key] !== true);

  return (
    <EvidenceModule
      id={id}
      title="Access posture"
      variant="strip"
      // Four facts read as one row; splitting would squeeze them into a half.
      bodyLayout="stack"
      className={className}
      visual={
        scored.length > 0 ? (
          <FactGrid
            aria-label="Scored access posture"
            items={scored.map((row) => ({ key: row.key, label: row.label, value: row.value }))}
          />
        ) : null
      }
      chipRow={
        review?.mixedPosture ? (
          <Badge variant="outline" className="border-border/60 bg-muted/30 text-xs" title={MIXED_POSTURE_NOTE}>
            Strictest across chains
          </Badge>
        ) : null
      }
      folds={
        <>
          {diagnostics.length > 0 ? (
            <ModuleDisclosure label="Reserve-access diagnostics" count={diagnostics.length}>
              <dl className="mt-1 space-y-1.5 pb-1">
                {diagnostics.map((row) => (
                  <div key={row.key} className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
                    <dt className="text-muted-foreground">{row.label}</dt>
                    <dd className="text-foreground">{row.value}</dd>
                  </div>
                ))}
              </dl>
            </ModuleDisclosure>
          ) : null}
          {review !== null ? <VerificationDisclosure review={review} /> : null}
        </>
      }
      footer={
        review !== null ? (
          <EvidenceFooter sources={collectReviewSources(review)} reviewed={review.reviewedAt} />
        ) : null
      }
    />
  );
}
