"use client";

import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import {
  groupSafetyScoreReasons,
  SAFETY_SCORE_VISIBLE_REASON_LIMIT,
} from "@/lib/safety-score-reason-labels";
import { cn } from "@/lib/utils";

/**
 * Evaluator reasons in reader wording: humanized, folded by template (one
 * line per unresolved datum class, not one per route) and capped at three
 * visible lines with the remainder behind a disclosure.
 */
export function SafetyScoreReasonList({
  messages,
  className,
}: {
  messages: readonly string[];
  className?: string;
}) {
  const groups = groupSafetyScoreReasons(messages);
  if (groups.length === 0) return null;
  const visible = groups.slice(0, SAFETY_SCORE_VISIBLE_REASON_LIMIT);
  const folded = groups.slice(SAFETY_SCORE_VISIBLE_REASON_LIMIT);
  const itemClass = "min-w-0 [overflow-wrap:anywhere]";
  return (
    <div className={cn("text-[11px] leading-snug text-muted-foreground", className)}>
      <ul className="space-y-1">
        {visible.map((group) => <li key={group.key} className={itemClass}>{group.text}</li>)}
      </ul>
      {folded.length > 0 ? (
        <ModuleDisclosure label="More reasons" count={folded.length} summaryClassName="text-xs">
          <ul className="space-y-1 pb-1">
            {folded.map((group) => <li key={group.key} className={itemClass}>{group.text}</li>)}
          </ul>
        </ModuleDisclosure>
      ) : null}
    </div>
  );
}
