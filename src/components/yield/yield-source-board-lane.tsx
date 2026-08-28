"use client";

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  YIELD_SOURCE_CONFIDENCE_DEFINITIONS,
  YIELD_SOURCE_CONFIDENCE_STYLES,
} from "@/lib/yield-source-risk";
import type { YieldSourceBoardGroup } from "@/lib/yield-source-board-model";
import { YIELD_TYPE_STYLES } from "@shared/lib/classification";

export function SourceLaneRow({ group }: { group: YieldSourceBoardGroup }) {
  const visibleSources = group.sourceLabels.slice(0, 3);
  const hiddenSourceCount = group.sourceLabels.slice(3).reduce((sum, source) => sum + source.count, 0);
  const tier = group.laneConfidenceTier;

  return (
    <li className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-baseline sm:gap-4 sm:px-5">
      <div className="flex shrink-0 items-center gap-2">
        <Badge variant="outline" className={cn("text-[11px]", YIELD_TYPE_STYLES[group.yieldType]?.badge ?? "")}>
          {group.yieldTypeLabel}
        </Badge>
        {tier ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                role="button"
                tabIndex={0}
                aria-label={`${YIELD_SOURCE_CONFIDENCE_DEFINITIONS[tier].label} confidence`}
                className="pharos-focus-ring inline-flex min-h-6 min-w-6 cursor-help items-center justify-center rounded-full"
              >
                <span aria-hidden="true" className={YIELD_SOURCE_CONFIDENCE_STYLES[tier].dot} />
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-[260px] text-xs">
              <span className="font-medium">{YIELD_SOURCE_CONFIDENCE_DEFINITIONS[tier].label}</span>
              <span className="block text-background/75">{YIELD_SOURCE_CONFIDENCE_DEFINITIONS[tier].description}</span>
            </TooltipContent>
          </Tooltip>
        ) : null}
        <span className="text-sm font-medium text-foreground">{group.dataSourceLabel}</span>
        <span className="pharos-numeric text-xs text-muted-foreground">
          {group.representedSourceCount} {group.representedSourceCount === 1 ? "observation" : "observations"}
        </span>
      </div>
      {visibleSources.length > 0 ? (
        <p className="min-w-0 text-xs leading-relaxed text-muted-foreground">
          {visibleSources.map((source) => `${source.label}${source.count > 1 ? ` x${source.count}` : ""}`).join(", ")}
          {hiddenSourceCount > 0 ? `, +${hiddenSourceCount} more` : ""}
        </p>
      ) : null}
    </li>
  );
}
