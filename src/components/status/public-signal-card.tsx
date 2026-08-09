import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { STATUS_PANEL_SHELL_CLASS } from "@/components/status/page-primitives";

interface PublicSignalCardProps {
  title: ReactNode;
  titleBadges?: ReactNode;
  badges?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  contentClassName?: string;
}

export function PublicSignalCard({
  title,
  titleBadges,
  badges,
  description,
  children,
  contentClassName,
}: PublicSignalCardProps) {
  return (
    // Always the flat panel: every consumer renders inside a StatusSection card
    // shell, and nesting a card inside a card is forbidden.
    <article className={cn("rounded-xl p-4", STATUS_PANEL_SHELL_CLASS)}>
      <div className={cn("flex flex-wrap justify-between gap-3", description ? "items-start" : "items-center")}>
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold tracking-tight text-foreground">{title}</h3>
            {titleBadges}
          </div>
          {description ? (
            <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {badges ? <div className="flex flex-wrap gap-2">{badges}</div> : null}
      </div>
      {children ? <div className={contentClassName ?? "mt-4 space-y-4"}>{children}</div> : null}
    </article>
  );
}
