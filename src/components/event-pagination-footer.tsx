"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface EventPaginationFooterProps {
  rangeStart: number;
  rangeEnd: number;
  total: number;
  onPreviousPage: () => void;
  onNextPage: () => void;
  previousDisabled: boolean;
  nextDisabled: boolean;
  className?: string;
  itemLabel?: string;
}

export function EventPaginationFooter({
  rangeStart,
  rangeEnd,
  total,
  onPreviousPage,
  onNextPage,
  previousDisabled,
  nextDisabled,
  className,
  itemLabel = "events",
}: EventPaginationFooterProps) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-3", className)}>
      <p className="text-sm text-muted-foreground">
        Showing{" "}
        <span className="font-mono">{rangeStart}</span>
        &ndash;
        <span className="font-mono">{rangeEnd}</span>
        {" "}of{" "}
        <span className="font-mono">{total.toLocaleString()}</span> {itemLabel}
      </p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onPreviousPage}
          disabled={previousDisabled}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onNextPage}
          disabled={nextDisabled}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
