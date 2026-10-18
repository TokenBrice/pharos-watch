import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { QueryViewState } from "@/lib/query-view-state";

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
      className={`pharos-focus-ring group flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] border border-border/75 bg-background/70 text-background shadow-[inset_0_1px_0_oklch(1_0_0_/0.5)] transition-colors hover:border-border hover:bg-muted/45 dark:border-white/10 dark:bg-black/20 dark:shadow-[inset_0_1px_0_oklch(1_0_0_/0.08)] dark:hover:bg-white/10 ${className ?? ""}`}
    >
      <span
        className="flex h-[15px] w-[15px] items-center justify-center rounded-[5px] bg-muted-foreground/65 transition-colors group-hover:bg-muted-foreground/80 dark:bg-muted-foreground/70 dark:group-hover:bg-muted-foreground/85"
        aria-hidden="true"
      >
        <ArrowRight className="h-3 w-3 stroke-[3]" aria-hidden="true" />
      </span>
    </Link>
  );
}
interface PulseCardProps {
  className: string;
  label: React.ReactNode;
  href: string;
  expandLabel: string;
  aside?: React.ReactNode;
  state: QueryViewState;
  loadingContent?: React.ReactNode;
  emptyContent?: React.ReactNode;
  unavailableWhen?: boolean;
  hasRenderableData?: boolean;
  children: React.ReactNode;
}

export function PulseCard({
  className,
  label,
  href,
  expandLabel,
  aside,
  state,
  loadingContent,
  emptyContent,
  unavailableWhen = false,
  hasRenderableData = true,
  children,
}: PulseCardProps): React.JSX.Element {
  // The homepage never renders data-health UI (docs/homepage.md): retained or
  // degraded data renders as-is, and no usable data is a neutral placeholder.
  const noData =
    state === "unavailable" || unavailableWhen || (state === "stale-with-data" && !hasRenderableData);
  const content =
    state === "loading" && loadingContent !== undefined
      ? loadingContent
      : noData
        ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-1 py-4 text-center">
              <span aria-hidden="true" className="pharos-numeric text-4xl font-bold tracking-tight text-muted-foreground/50">—</span>
              <span className="pharos-meta">Updating</span>
            </div>
          )
        : state === "empty" && emptyContent !== undefined ? emptyContent : children;

  return (
    <div className={className}>
      <PulseCardHeader label={label} href={href} expandLabel={expandLabel} aside={aside} />
      {content}
    </div>
  );
}


// Shared header row for Market Pulse cards: sentence-case label top-left, an
// optional right-aligned meta aside, then the expand button in the corner.
function PulseCardHeader({
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
