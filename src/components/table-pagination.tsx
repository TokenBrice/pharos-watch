import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChevronLeft, ChevronRight } from "lucide-react";

export interface TablePaginationProps {
  page: number;
  totalPages: number;
  rangeStart: number;
  rangeEnd: number;
  total: number;
  onPrevious?: () => void;
  onNext?: () => void;
  noun?: string;
  className?: string;
  bordered?: boolean;
  showControls?: boolean;
  supplementaryText?: React.ReactNode;
}

export function TablePagination({
  page,
  totalPages,
  rangeStart,
  rangeEnd,
  total,
  onPrevious,
  onNext,
  noun = "stablecoins",
  className,
  bordered = true,
  showControls = true,
  supplementaryText,
}: TablePaginationProps) {
  const formattedRangeStart = rangeStart.toLocaleString();
  const formattedRangeEnd = rangeEnd.toLocaleString();
  const formattedTotal = total.toLocaleString();

  return (
    <div
      className={cn(
        "flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between",
        bordered && "border-t",
        className,
      )}
    >
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
        <span className="text-sm text-muted-foreground" aria-live="polite">
          Showing{" "}
          <span className="font-mono tabular-nums">{formattedRangeStart}</span>
          {"–"}
          <span className="font-mono tabular-nums">{formattedRangeEnd}</span>
          {" "}of{" "}
          <span className="font-mono tabular-nums">{formattedTotal}</span> {noun}
        </span>
        {supplementaryText ? <span className="pharos-meta">{supplementaryText}</span> : null}
      </div>
      {showControls ? (
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="pharos-focus-ring h-10 min-w-10 sm:h-8 sm:min-w-8"
            onClick={onPrevious}
            disabled={page === 0}
            aria-label="Go to previous page"
            aria-disabled={page === 0}
          >
            <ChevronLeft className="h-4 w-4" />
            <span>Previous</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="pharos-focus-ring h-10 min-w-10 sm:h-8 sm:min-w-8"
            onClick={onNext}
            disabled={page >= totalPages - 1}
            aria-label="Go to next page"
            aria-disabled={page >= totalPages - 1}
          >
            <span>Next</span>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
