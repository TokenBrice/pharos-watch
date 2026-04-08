"use client";

import { Info } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

export { BackingBreakdown } from "./backing-breakdown";
export { CompositionSection } from "./composition-section";
export { HealthBreakdownCard } from "./health-breakdown-card";
export { HeroCard } from "./hero-card";
export { StablecoinTable } from "./stablecoin-table";

export function DetailedSectionsNotice({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <Card className="border-amber-500/20 bg-amber-500/10">
      <CardContent className="flex items-start gap-3 px-5 py-4">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="space-y-2">
          <p className="text-sm text-amber-900 dark:text-amber-100">{message}</p>
          <button
            onClick={onRetry}
            className="pharos-focus-ring text-xs font-medium text-amber-800 underline hover:text-amber-900 dark:text-amber-200 dark:hover:text-amber-100"
          >
            Retry sync
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
