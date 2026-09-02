import Link from "next/link";
import { SquareArrowRight } from "lucide-react";

export function HomeAltTrackerLink({
  href,
  ariaLabel,
  prefetch,
}: {
  href: string;
  ariaLabel: string;
  prefetch?: boolean;
}) {
  return (
    <Link
      href={href}
      prefetch={prefetch}
      aria-label={ariaLabel}
      className="pharos-focus-ring group inline-flex min-h-7 items-center gap-1.5 rounded-[4px] border border-border/70 bg-muted/30 px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:border-border hover:bg-muted/60 sm:min-h-8 sm:rounded-md sm:px-3 sm:py-1.5 sm:text-[13px]"
    >
      Tracker
      <SquareArrowRight
        aria-hidden="true"
        className="h-3 w-3 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-foreground sm:h-3.5 sm:w-3.5"
        strokeWidth={2}
      />
    </Link>
  );
}
