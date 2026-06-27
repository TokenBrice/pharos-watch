import Link from "next/link";
import { Maximize2 } from "lucide-react";

// Small square ghost button that links a pulse card to its detail route — the
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
      className={`pharos-focus-ring flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground ${className ?? ""}`}
    >
      <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
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
