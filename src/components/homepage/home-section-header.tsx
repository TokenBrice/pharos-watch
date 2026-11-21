import type { ReactNode } from "react";

interface HomeSectionHeaderProps {
  titleId: string;
  title: string;
  subtitle: ReactNode;
  stat?: ReactNode;
  action?: ReactNode;
}

/**
 * Unified below-fold section header for homepage modules: semantic `<h2>`,
 * readable `text-sm` subtitle across every breakpoint, and an optional
 * right-aligned stat + tracker link.
 */
export function HomeSectionHeader({
  titleId,
  title,
  subtitle,
  stat,
  action,
}: HomeSectionHeaderProps): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="flex items-start justify-between gap-3">
        <h2
          id={titleId}
          className="pharos-display text-2xl font-bold leading-tight tracking-tight text-foreground sm:text-3xl"
        >
          {title}
        </h2>
        {(stat || action) ? (
          <div className="flex shrink-0 items-center gap-3 pt-0.5 sm:pt-1">
            {stat ? (
              <>
                <span className="hidden text-sm text-muted-foreground sm:inline">{stat}</span>
                {action ? <span aria-hidden="true" className="hidden h-1 w-1 rounded-full bg-border sm:inline-block" /> : null}
              </>
            ) : null}
            {action}
          </div>
        ) : null}
      </div>
      <p className="text-sm leading-snug text-muted-foreground">{subtitle}</p>
    </div>
  );
}
