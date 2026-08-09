import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

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
    <article className="rounded-xl border border-border/60 bg-background/35 p-4">
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
