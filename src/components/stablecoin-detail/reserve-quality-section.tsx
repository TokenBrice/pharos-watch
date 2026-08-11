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
import {
  formatReserveQualityPct,
  type ReserveQualityClientSummary,
  type ReserveQualityLadderClientRow,
} from "@/lib/stablecoin-detail-reserve-quality-client";
import { cn } from "@/lib/utils";

const AMBER_VALUE_CLASS = "text-amber-600 dark:text-amber-400";

function LadderRow({ row }: { row: ReserveQualityLadderClientRow }) {
  const isUnknown = row.key === "unknown";
  return (
    <li className="flex items-center gap-3">
      <span
        className={cn(
          "w-20 shrink-0 text-[10px] font-medium uppercase leading-tight tracking-[0.14em]",
          isUnknown ? AMBER_VALUE_CLASS : "text-muted-foreground",
        )}
      >
        {row.label}
      </span>
      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div
          className={cn("h-full rounded-full", isUnknown ? "bg-amber-500/50" : "bg-foreground/40")}
          style={{ width: `${Math.max(0, Math.min(100, row.pct))}%` }}
        />
      </div>
      <span
        className={cn(
          "w-12 shrink-0 text-right font-mono text-xs tabular-nums",
          isUnknown ? AMBER_VALUE_CLASS : "text-muted-foreground",
        )}
      >
        {formatReserveQualityPct(row.pct)}
      </span>
    </li>
  );
}

/**
 * How good the backing actually is: the curated reserve slices' quality
 * attributes (asset-class mix, time-to-liquidate ladder, per-slice risk
 * factors and obligors) plus the reserve review's disclosure-quality numbers
 * (unidentified obligors, self-exposure, composition as-of). Renders nothing
 * for coins whose reserve slices carry no quality attributes.
 */
export function ReserveQualitySection({ summary }: { summary?: ReserveQualityClientSummary | null }) {
  if (!summary) return null;

  const facts: FactGridItem[] = [
    ...(summary.unidentifiedObligorsPct != null
      ? [
          {
            key: "unidentified",
            label: "Unidentified obligors",
            value: formatReserveQualityPct(summary.unidentifiedObligorsPct),
            ...(summary.unidentifiedObligorsPct > 0 ? { valueClassName: AMBER_VALUE_CLASS } : {}),
          },
        ]
      : []),
    ...(summary.selfExposurePct != null
      ? [
          {
            key: "self-exposure",
            label: "Self-exposure",
            value: formatReserveQualityPct(summary.selfExposurePct),
            valueClassName: AMBER_VALUE_CLASS,
          },
        ]
      : []),
    ...(summary.topPositionPct != null
      ? [
          {
            key: "top-position",
            label: "Top position",
            value: formatReserveQualityPct(summary.topPositionPct),
            title: summary.topPositionName ?? undefined,
          },
        ]
      : []),
    ...(summary.asOf != null ? [{ key: "as-of", label: "As of", value: summary.asOf }] : []),
    { key: "slices", label: "Slices", value: String(summary.sliceCount) },
    ...(summary.confidenceLabel != null
      ? [{ key: "confidence", label: "Confidence", value: summary.confidenceLabel }]
      : []),
  ];

  return (
    <Card id="reserve-quality" className={cn(DETAIL_MODULE_SHELL_CLASS, SECTION_SCROLL_MT)}>
      <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
        <DetailSectionTitle className={DETAIL_MODULE_TITLE_CLASS}>Reserve quality</DetailSectionTitle>
        <Badge variant="outline" className={cn("text-[11px] font-medium", summary.chipToneClass)}>
          {summary.chipLabel}
        </Badge>
      </CardHeader>
      <CardContent className={cn(DETAIL_MODULE_BODY_CLASS, "space-y-4")}>
        <p className="text-sm leading-relaxed text-muted-foreground">{summary.lede}</p>
        {summary.mix.length > 0 ? (
          <div>
            <div className="text-[10px] font-medium uppercase leading-tight tracking-[0.14em] text-muted-foreground">
              Asset mix
            </div>
            <div
              className="mt-2 flex h-2 overflow-hidden rounded-full bg-muted"
              role="img"
              aria-label={`Asset-class mix: ${summary.mix
                .map((row) => `${row.label} ${formatReserveQualityPct(row.pct)}`)
                .join(", ")}`}
            >
              {summary.mix.map((row) => (
                <div
                  key={row.key}
                  className={cn("h-full", row.barClass)}
                  style={{ width: `${Math.max(0, Math.min(100, row.pct))}%` }}
                />
              ))}
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground" aria-hidden="true">
              {summary.mix.map((row, index) => (
                <span key={row.key}>
                  {index > 0 ? " · " : ""}
                  {row.label}{" "}
                  <span className="font-mono tabular-nums text-foreground">{formatReserveQualityPct(row.pct)}</span>
                </span>
              ))}
            </p>
          </div>
        ) : null}
        {summary.ladder.length > 0 ? (
          <div>
            <div className="text-[10px] font-medium uppercase leading-tight tracking-[0.14em] text-muted-foreground">
              Time to liquidate
            </div>
            <ul aria-label="Liquidity horizon ladder" className="mt-2 space-y-1.5">
              {summary.ladder.map((row) => (
                <LadderRow key={row.key} row={row} />
              ))}
            </ul>
          </div>
        ) : null}
        <FactGrid aria-label="Reserve quality facts" items={facts} />
        <ModuleDisclosure label="Slice detail & risk factors">
          <div className="mt-3 space-y-3">
            {summary.compositionBasis ? (
              <p className="text-xs leading-relaxed text-muted-foreground">{summary.compositionBasis}</p>
            ) : null}
            {summary.knownUnknownExposureNote ? (
              <p className="text-xs leading-relaxed text-muted-foreground">{summary.knownUnknownExposureNote}</p>
            ) : null}
            <ul aria-label="Reserve slices" className="space-y-2.5">
              {summary.slices.map((slice) => (
                <li key={slice.key} className="space-y-0.5">
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    <span className="font-mono text-foreground">{slice.name}</span>
                    {` · ${formatReserveQualityPct(slice.pct)}`}
                    {slice.assetClassLabel ? ` · ${slice.assetClassLabel}` : ""}
                    {slice.horizonLabel ? ` · ${slice.horizonLabel}` : ""}
                    {` · ${slice.riskLabel} risk`}
                  </p>
                  {slice.obligor ? (
                    <p className="text-xs leading-relaxed text-muted-foreground">{`Obligor: ${slice.obligor}`}</p>
                  ) : null}
                  {slice.riskFactorLabels.length > 0 ? (
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {`Risk factors: ${slice.riskFactorLabels.join(" · ")}`}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        </ModuleDisclosure>
        <EvidenceFooter
          sources={summary.sources.map((source) => ({ label: source.label, url: source.url }))}
          trailing={summary.reviewedAt ? `Reviewed ${summary.reviewedAt}` : undefined}
        />
      </CardContent>
    </Card>
  );
}
