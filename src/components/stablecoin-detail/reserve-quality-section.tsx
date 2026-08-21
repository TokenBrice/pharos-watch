"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
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
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import {
  formatReserveQualityPct,
  type ReserveQualityClientSummary,
  type ReserveQualityLadderClientRow,
} from "@/lib/stablecoin-detail-reserve-quality-client";
import { cn } from "@/lib/utils";

const AMBER_VALUE_CLASS = "text-amber-600 dark:text-amber-400";

/**
 * How fast this share of the basket converts to cash — an ordinal risk ramp,
 * so the bar and the figure both carry the horizon's severity tone. The row
 * label stays muted so the colour reads as one signal per row rather than
 * three. `minWidth` keeps a fractional share (0.1%) visible instead of
 * collapsing to an empty track.
 */
function LadderRow({ row }: { row: ReserveQualityLadderClientRow }) {
  const tone = SEVERITY_TONE_CLASS[row.tone];
  return (
    <li className="flex items-center gap-3">
      <span className="w-20 shrink-0 text-[10px] font-medium uppercase leading-tight tracking-[0.14em] text-muted-foreground">
        {row.label}
      </span>
      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div
          className={cn("h-full rounded-full", tone.bar)}
          style={{ width: `${Math.max(0, Math.min(100, row.pct))}%`, minWidth: "3px" }}
        />
      </div>
      <span className={cn("w-12 shrink-0 text-right font-mono text-xs tabular-nums", tone.text)}>
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
        <StablecoinModuleTitle className={DETAIL_MODULE_TITLE_CLASS}>Reserve quality</StablecoinModuleTitle>
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
            {/* Swatches, not a run-on sentence: the mix bar is categorical now,
                so each name needs its colour to be readable against the bar. */}
            <ul
              className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs leading-relaxed text-muted-foreground"
              aria-hidden="true"
            >
              {summary.mix.map((row) => (
                <li key={row.key} className="flex items-center gap-1.5">
                  <span className={cn("size-2 shrink-0 rounded-full", row.barClass)} />
                  {row.label}{" "}
                  <span className="font-mono tabular-nums text-foreground">{formatReserveQualityPct(row.pct)}</span>
                </li>
              ))}
            </ul>
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
