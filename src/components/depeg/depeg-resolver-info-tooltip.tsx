"use client";

import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

type DdrInfoTooltipWidth = "narrow" | "wide";

const MAX_WIDTH_CLASS: Record<DdrInfoTooltipWidth, string> = {
  narrow: "max-w-[280px]",
  wide: "max-w-[300px]",
};

export function DdrInfoTooltip({
  ariaLabel,
  content,
  maxWidth = "narrow",
}: {
  ariaLabel: string;
  content: ReactNode;
  maxWidth?: DdrInfoTooltipWidth;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          aria-label={ariaLabel}
          className="pharos-focus-ring inline-flex h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
        >
          <Info className="h-3.5 w-3.5" aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent className={MAX_WIDTH_CLASS[maxWidth]}>{content}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
