import Link from "next/link";
import { Maximize2 } from "lucide-react";

// Small square button that links a pulse card to its detail route — the
// "expand" affordance in the top-right corner of every Market Pulse card.
export function CardExpandButton({
  href,
  expandLabel,
  className,
}: {
  href: string;
  expandLabel: string;
  className?: string;
}): React.JSX.Element {
  return (
    <Link
      prefetch={false}
      href={href}
      aria-label={expandLabel}
      className={`pharos-focus-ring flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] border border-border/70 bg-muted/55 text-muted-foreground shadow-[inset_0_1px_0_oklch(1_0_0_/0.55)] transition-colors hover:border-border hover:bg-muted hover:text-foreground dark:border-white/8 dark:bg-white/10 dark:text-muted-foreground dark:shadow-[inset_0_1px_0_oklch(1_0_0_/0.08)] dark:hover:bg-white/14 dark:hover:text-foreground ${className ?? ""}`}
    >
      <Maximize2 className="h-3 w-3" aria-hidden="true" />
    </Link>
  );
}

// Shared header row for Market Pulse cards: sentence-case label top-left, an
// optional right-aligned meta aside, then the expand button in the corner.
export function PulseCardHeader({
  label,
  href,
  expandLabel,
  aside,
}: {
  label: React.ReactNode;
  href: string;
  expandLabel: string;
  aside?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0 text-sm font-medium text-muted-foreground">{label}</div>
      <div className="flex shrink-0 items-center gap-2">
        {aside}
        <CardExpandButton href={href} expandLabel={expandLabel} className="-mr-1" />
      </div>
    </div>
  );
}
