"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { FactGrid, type FactGridItem } from "@/components/stablecoin-detail/fact-grid";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import {
  DETAIL_MODULE_BODY_CLASS,
  DETAIL_MODULE_HEADER_CLASS,
  DETAIL_MODULE_SHELL_CLASS,
  DETAIL_MODULE_TITLE_CLASS,
  SECTION_SCROLL_MT,
} from "@/components/stablecoin-detail/section-title-class";
import type { OracleBranchClientRow, OracleRiskClientSummary } from "@/lib/stablecoin-detail-oracle-client";
import { cn } from "@/lib/utils";

function branchHasDetail(branch: OracleBranchClientRow): boolean {
  return (
    branch.feeds.length > 0 ||
    branch.collateralParameters.length > 0 ||
    branch.liquidationMechanism != null ||
    branch.backstop != null ||
    branch.fallbackBehavior != null ||
    branch.shutdownOrBadDebtBehavior != null
  );
}

/**
 * What prices the collateral and what happens when the price is wrong: the
 * reviewed `oracleRisk` profile (tier verdict, per-branch debt shares, feeds
 * with heartbeat/staleness bounds, LTV/MCR parameters, liquidation and
 * shutdown mechanics). Renders nothing for coins without an oracle review —
 * most fiat-backed issuers.
 */
export function OracleLiquidationSection({ summary }: { summary?: OracleRiskClientSummary | null }) {
  if (!summary) return null;

  const facts: FactGridItem[] = [
    ...(summary.branchCount > 0
      ? [{ key: "branches", label: "Branches", value: String(summary.branchCount) }]
      : []),
    ...(summary.feedCount > 0 ? [{ key: "feeds", label: "Feeds", value: String(summary.feedCount) }] : []),
    ...(summary.worstMaxLtvPct != null
      ? [{ key: "max-ltv", label: "Max LTV", value: `${summary.worstMaxLtvPct}%` }]
      : []),
    ...(summary.worstMinCrPct != null
      ? [{ key: "min-cr", label: "Min CR", value: `${summary.worstMinCrPct}%` }]
      : []),
    ...(summary.maxLiquidationDelayLabel != null
      ? [{ key: "liq-delay", label: "Liq. delay", value: summary.maxLiquidationDelayLabel }]
      : []),
    ...(summary.confidenceLabel != null
      ? [{ key: "confidence", label: "Confidence", value: summary.confidenceLabel }]
      : []),
  ];

  const detailBranches = summary.branches.filter(branchHasDetail);

  return (
    <Card id="oracle" className={cn(DETAIL_MODULE_SHELL_CLASS, SECTION_SCROLL_MT)}>
      <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
        <DetailSectionTitle className={DETAIL_MODULE_TITLE_CLASS}>Oracle & liquidation</DetailSectionTitle>
        <Badge variant="outline" className={cn("text-[11px] font-medium", summary.tierToneClass)}>
          {summary.tierLabel}
        </Badge>
      </CardHeader>
      <CardContent className={cn(DETAIL_MODULE_BODY_CLASS, "space-y-4")}>
        <p className="text-sm leading-relaxed text-muted-foreground">{summary.summary}</p>
        <FactGrid aria-label="Oracle and liquidation facts" items={facts} />
        {summary.branches.length > 0 ? (
          <ul className="space-y-3">
            {summary.branches.map((branch) => (
              <li key={branch.id}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">{branch.label}</span>
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
            ))}
          </ul>
        ) : null}
        {detailBranches.length > 0 ? (
          <ModuleDisclosure label="Feeds, parameters & failure behavior">
            <div className="mt-3 space-y-4">
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
                    <p className="text-xs leading-relaxed text-muted-foreground">{branch.liquidationMechanism}</p>
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
