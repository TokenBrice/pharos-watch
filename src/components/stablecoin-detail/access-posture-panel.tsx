"use client";

import { useState } from "react";
import { LockKeyhole } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { InlineDisclosureToggle } from "@/components/stablecoin-detail/disclosure-toggles";
import {
  EvidenceFooter,
  type EvidenceFooterSource,
} from "@/components/stablecoin-detail/evidence-footer";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { RailCard } from "@/components/stablecoin-detail/rail-card";
import type { StablecoinSafetyScoreV9AccessRow } from "@/lib/stablecoin-safety-score-v9-presentation";
import type { TransferReviewDeployment, TransferReviewView } from "@/lib/transfer-review";

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
        <InlineDisclosureToggle
          open={open}
          onToggle={() => setOpen((value) => !value)}
          collapsedLabel={`How this was verified · ${review.deployments.length} ${review.deployments.length === 1 ? "deployment" : "deployments"}`}
          className="mt-2"
        />
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
            {/* `Reviewed {date}` as plain trailing text, matching the four
                sibling `EvidenceFooter` call sites. `ReviewedStamp` is the
                *header* chip primitive (backing-mechanics, collateralization);
                the footer row has its own one spelling. */}
            <EvidenceFooter
              className="mt-3"
              sources={collectReviewSources(review)}
              trailing={`Reviewed ${review.reviewedAt}`}
            />
          </div>
        ) : null}
      </>
    );

  if (compact) {
    return (
      <RailCard
        title="Access posture"
        ariaLabel="Access posture"
        trailing={<LockKeyhole className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
      >
        <div className="px-4 pb-4">
          {list}
          {evidence}
        </div>
      </RailCard>
    );
  }

  // In-flow (below xl) the posture rows fold behind the standard disclosure;
  // the rail keeps its at-a-glance expanded copy at xl+.
  return (
    <section className="border-b border-border/40 pb-3 xl:hidden" aria-label="Access posture">
      <ModuleDisclosure label="Access posture">
        <div className="mt-1">
          {list}
          {evidence}
        </div>
      </ModuleDisclosure>
    </section>
  );
}
