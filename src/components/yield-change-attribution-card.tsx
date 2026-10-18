import { MethodologyHint } from "@/components/methodology-hint";
import { cn } from "@/lib/utils";
import type { YieldChangeAttributionResult } from "@/lib/yield-change-attribution";
import { formatYieldApyDelta } from "@/lib/yield-presentation";
import { YIELD_ATTRIBUTION_TONE_CLASSES } from "@shared/lib/classification";

const ATTRIBUTION_TONE: Record<YieldChangeAttributionResult["attribution"], { wrapper: string; kicker: string }> =
  YIELD_ATTRIBUTION_TONE_CLASSES;

export function YieldChangeAttributionCard({ attribution }: { attribution: YieldChangeAttributionResult }) {
  const tone = ATTRIBUTION_TONE[attribution.attribution];
  const hasEvidence = attribution.largestDelta !== null || attribution.sourceSwitchDetail !== undefined;
  return (
    <div className={cn("rounded-xl border px-4 py-3", tone.wrapper)}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className={cn("pharos-label", tone.kicker)}>Why this APY changed</p>
        <span aria-hidden="true" className="text-muted-foreground/40">
          ·
        </span>
        <span className="pharos-label">
          {attribution.confidence} confidence
        </span>
        <MethodologyHint topic="pys" />
      </div>
      <p className="mt-1.5 text-sm text-foreground">{attribution.headline}</p>
      {hasEvidence ? (
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="flex min-h-6 cursor-pointer select-none items-center rounded-sm pharos-focus-ring underline-offset-4 hover:text-foreground hover:underline">
            Show evidence
          </summary>
          <ul className="mt-2 space-y-1">
            {attribution.largestDelta ? (
              <li>
                Largest 30d move:{" "}
                <span className="font-mono tabular-nums text-foreground">
                  {formatYieldApyDelta(attribution.largestDelta.value)}
                </span>{" "}
                on{" "}
                <span className="font-mono tabular-nums text-foreground">
                  {new Date(attribution.largestDelta.ts).toISOString().slice(0, 10)}
                </span>
                .
              </li>
            ) : null}
            {attribution.sourceSwitchDetail ? (
              <li>
                Source switched from{" "}
                <span className="text-foreground">
                  {attribution.sourceSwitchDetail.previousSourceLabel ??
                    attribution.sourceSwitchDetail.previousSourceKey}
                </span>{" "}
                with{" "}
                <span className="font-mono tabular-nums text-foreground">
                  {formatYieldApyDelta(attribution.sourceSwitchDetail.apy30dDelta)}
                </span>{" "}
                impact on 30d APY.
              </li>
            ) : null}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
