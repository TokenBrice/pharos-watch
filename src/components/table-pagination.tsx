import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";

export interface TablePaginationProps {
  page: number;
  totalPages: number;
  rangeStart: number;
  rangeEnd: number;
  total: number;
  onPrevious: () => void;
  onNext: () => void;
  noun?: string;
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
}: TablePaginationProps) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-t">
      <span className="text-sm text-muted-foreground" aria-live="polite">
        Showing {rangeStart}–{rangeEnd} of {total} {noun}
      </span>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-10 min-w-10 sm:h-8 sm:min-w-8"
          onClick={onPrevious}
          disabled={page === 0}
        >
          <ChevronLeft className="h-4 w-4" />
          <span>Previous</span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-10 min-w-10 sm:h-8 sm:min-w-8"
          onClick={onNext}
          disabled={page >= totalPages - 1}
        >
          <span>Next</span>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
