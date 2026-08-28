"use client";

import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { YieldSourceFreshnessDisplay } from "@/lib/yield-source-risk";

type YieldFreshnessLabelMode = "interactive" | "plain-title";

const YIELD_FRESHNESS_LABEL_CLASS_NAMES: Record<YieldFreshnessLabelMode, string | undefined> = {
  interactive: "cursor-help",
  "plain-title": undefined,
};

interface YieldFreshnessLabelRenderProps {
  className: string;
  label: string;
}

export function YieldFreshnessLabel({
  freshness,
  mode = "interactive",
  className,
  render,
}: {
  freshness: YieldSourceFreshnessDisplay;
  mode?: YieldFreshnessLabelMode;
  className?: string;
  render?: (props: YieldFreshnessLabelRenderProps) => ReactNode;
}) {
  const labelClassName = cn(YIELD_FRESHNESS_LABEL_CLASS_NAMES[mode], freshness.textClassName, className);
  const label = render ? render({ className: labelClassName, label: freshness.displayText }) : (
    <span className={labelClassName}>{freshness.displayText}</span>
  );

  if (mode === "plain-title") {
    return render ? label : <span className={labelClassName} title={freshness.tooltipText}>{freshness.displayText}</span>;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{label}</TooltipTrigger>
      <TooltipContent className="text-[11px]">{freshness.tooltipText}</TooltipContent>
    </Tooltip>
  );
}
