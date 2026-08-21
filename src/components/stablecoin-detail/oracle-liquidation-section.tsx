"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CollapsibleProse } from "@/components/stablecoin-detail/collapsible-prose";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { FactGrid, type FactGridItem } from "@/components/stablecoin-detail/fact-grid";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { StablecoinModuleTitle } from "@/components/stablecoin-detail/module-title";
import {
  DETAIL_MODULE_BODY_CLASS,
  DETAIL_MODULE_HEADER_CLASS,
  DETAIL_MODULE_SHELL_CLASS,
  DETAIL_MODULE_TITLE_CLASS,
  SECTION_SCROLL_MT,
} from "@/components/stablecoin-detail/section-title-class";
import { formatOraclePct, type OracleBranchClientRow, type OracleRiskClientSummary } from "@/lib/stablecoin-detail-oracle-client";
import { cn } from "@/lib/utils";

/** Inline branches beyond this count move into the disclosure, sorted forward. */
const INLINE_BRANCH_LIMIT = 6;

function branchHasDetail(branch: OracleBranchClientRow): boolean {
  return (
    branch.feeds.length > 0 ||
    branch.collateralParameters.length > 0 ||
    branch.liquidationMechanism != null ||
    branch.liquidationDelayLabel != null ||
    branch.backstop != null ||
    branch.fallbackBehavior != null ||
    branch.shutdownOrBadDebtBehavior != null
  );
}

/**
 * Highest debt-share branches first (null shares — unmeasured, so treated as
 * material — sort last), preserving the curated order otherwise. Coins with
 * many branches (up to ~40) need this so the six inline rows are the ones
 * that matter most; the projection itself stays in curated order since the
 * disclosure detail below still walks every branch in that order.
 */
export function sortOracleBranchesForDisplay(branches: readonly OracleBranchClientRow[]): OracleBranchClientRow[] {
  return branches
    .map((branch, index) => ({ branch, index }))
    .sort((a, b) => {
      if (a.branch.debtSharePct == null && b.branch.debtSharePct == null) return a.index - b.index;
      if (a.branch.debtSharePct == null) return 1;
      if (b.branch.debtSharePct == null) return -1;
      if (a.branch.debtSharePct !== b.branch.debtSharePct) return b.branch.debtSharePct - a.branch.debtSharePct;
      return a.index - b.index;
    })
    .map(({ branch }) => branch);
}

function BranchSummaryRow({ branch, tierLabel }: { branch: OracleBranchClientRow; tierLabel: string }) {
  return (
    <li>
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="text-sm font-medium text-foreground">{branch.label}</span>
          {branch.tierLabel !== tierLabel ? (
            <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{branch.tierLabel}</span>
          ) : null}
        </span>
        {branch.debtSharePct != null ? (
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            {branch.debtSharePct}% of debt
          </span>
        ) : null}
      </div>
      {branch.debtSharePct != null ? (
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
          <div
            className="h-full rounded-full bg-foreground/40"
            style={{ width: `${Math.max(0, Math.min(100, branch.debtSharePct))}%` }}
          />
        </div>
      ) : null}
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{branch.summary}</p>
    </li>
  );
}

/**
 * What prices the collateral and what happens when the price is wrong: the
 * reviewed `oracleRisk` profile (tier verdict, per-branch debt shares, feeds
 * with heartbeat/staleness bounds, LTV/MCR parameters, liquidation and
 * shutdown mechanics). Renders nothing for coins without an oracle review —
 * most fiat-backed issuers.
 *
 * The title and lead-in come from the profile's role: a feed that prices
 * borrower collateral inside a liquidation engine is solvency machinery, while
 * a feed that prices the coin itself exposes its consumers instead. Both share
 * the tier vocabulary, so without the split readers read them as one thing.
 */
export function OracleLiquidationSection({ summary }: { summary?: OracleRiskClientSummary | null }) {
  if (!summary) return null;

  const facts: FactGridItem[] = [
    ...(summary.branchCount > 0
      ? [{ key: "branches", label: "Branches", value: String(summary.branchCount) }]
      : []),
    ...(summary.feedCount > 0 ? [{ key: "feeds", label: "Feeds", value: String(summary.feedCount) }] : []),
    ...(summary.worstMaxLtvPct != null
      ? [{ key: "max-ltv", label: "Max LTV", value: formatOraclePct(summary.worstMaxLtvPct) }]
      : []),
    ...(summary.worstMinCrPct != null
      ? [{ key: "min-cr", label: "Min CR", value: formatOraclePct(summary.worstMinCrPct) }]
      : []),
    ...(summary.maxLiquidationDelayLabel != null
      ? [{ key: "liq-delay", label: "Liq. delay", value: summary.maxLiquidationDelayLabel }]
      : []),
    ...(summary.confidenceLabel != null
      ? [{ key: "confidence", label: "Confidence", value: summary.confidenceLabel }]
      : []),
  ];

  const detailBranches = summary.branches.filter(branchHasDetail);
  const sortedBranches = sortOracleBranchesForDisplay(summary.branches);
  const inlineBranches = sortedBranches.slice(0, INLINE_BRANCH_LIMIT);
  const overflowBranches = sortedBranches.slice(INLINE_BRANCH_LIMIT);

  return (
    <Card id="oracle" className={cn(DETAIL_MODULE_SHELL_CLASS, SECTION_SCROLL_MT)}>
      <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
        <StablecoinModuleTitle className={DETAIL_MODULE_TITLE_CLASS}>{summary.title}</StablecoinModuleTitle>
        <Badge variant="outline" className={cn("text-[11px] font-medium", summary.tierToneClass)}>
          {summary.tierLabel}
        </Badge>
      </CardHeader>
      <CardContent className={cn(DETAIL_MODULE_BODY_CLASS, "space-y-4")}>
        <div>
          <p className="mb-3 text-xs leading-relaxed text-muted-foreground">{summary.roleNote}</p>
          {/* 14 of 81 CDP oracle summaries run past 400 characters. */}
          <CollapsibleProse text={summary.summary} className="text-sm" toggleClassName="mt-2" size="md" />
        </div>
        <FactGrid aria-label={`${summary.title} facts`} items={facts} />
        {inlineBranches.length > 0 ? (
          <div>
            <ul aria-label="Oracle branches" className="space-y-3">
              {inlineBranches.map((branch) => (
                <BranchSummaryRow key={branch.id} branch={branch} tierLabel={summary.tierLabel} />
              ))}
            </ul>
            {overflowBranches.length > 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                + {overflowBranches.length} more branches in the breakdown below
              </p>
            ) : null}
          </div>
        ) : null}
        {detailBranches.length > 0 || overflowBranches.length > 0 ? (
          <ModuleDisclosure label="Feeds, parameters & failure behavior">
            <div className="mt-3 space-y-4">
              {overflowBranches.length > 0 ? (
                <ul aria-label="Additional oracle branches" className="space-y-3">
                  {overflowBranches.map((branch) => (
                    <BranchSummaryRow key={branch.id} branch={branch} tierLabel={summary.tierLabel} />
                  ))}
                </ul>
              ) : null}
              {detailBranches.map((branch) => (
                <div key={branch.id} className="space-y-1.5">
                  <div className="text-[10px] font-medium uppercase leading-tight tracking-[0.14em] text-muted-foreground">
                    {branch.label}
                  </div>
                  {branch.feeds.map((feed) => (
                    <p key={feed.key} className="text-xs leading-relaxed text-muted-foreground">
                      <span className="font-mono text-foreground">{feed.path}</span>
                      {` · ${feed.provider} · ${feed.chain}`}
                      {feed.heartbeatLabel ? ` · ${feed.heartbeatLabel} heartbeat` : ""}
                      {feed.stalenessLabel ? ` · ${feed.stalenessLabel} staleness bound` : ""}
                    </p>
                  ))}
                  {branch.collateralParameters.map((parameter) => (
                    <p key={parameter.key} className="text-xs leading-relaxed text-muted-foreground">
                      <span className="font-mono text-foreground">{parameter.asset}</span>
                      {parameter.maxLtvLabel ? ` · max LTV ${parameter.maxLtvLabel}` : ""}
                      {parameter.minCrLabel ? ` · MCR ${parameter.minCrLabel}` : ""}
                      {parameter.shutdownCrLabel ? ` · shutdown CR ${parameter.shutdownCrLabel}` : ""}
                      {parameter.note ? ` · ${parameter.note}` : ""}
                    </p>
                  ))}
                  {branch.liquidationMechanism ? (
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {branch.liquidationMechanism}
                      {branch.liquidationDelayLabel != null ? ` · liquidation delay ${branch.liquidationDelayLabel}` : ""}
                    </p>
                  ) : branch.liquidationDelayLabel != null ? (
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {`Liquidation delay ${branch.liquidationDelayLabel}`}
                    </p>
                  ) : null}
                  {branch.backstop ? (
                    <p className="text-xs leading-relaxed text-muted-foreground">{branch.backstop}</p>
                  ) : null}
                  {branch.fallbackBehavior ? (
                    <p className="text-xs leading-relaxed text-muted-foreground">{branch.fallbackBehavior}</p>
                  ) : null}
                  {branch.shutdownOrBadDebtBehavior ? (
                    <p className="text-xs leading-relaxed text-muted-foreground">{branch.shutdownOrBadDebtBehavior}</p>
                  ) : null}
                </div>
              ))}
            </div>
          </ModuleDisclosure>
        ) : null}
        <EvidenceFooter
          sources={summary.sources.map((source) => ({ label: source.label, url: source.url }))}
          trailing={summary.reviewedAt ? `Reviewed ${summary.reviewedAt}` : undefined}
        />
      </CardContent>
    </Card>
  );
}
