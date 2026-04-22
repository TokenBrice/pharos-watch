import type { ReactNode } from "react";

interface PublicSignalCardProps {
  title: string;
  badges?: ReactNode;
  children: ReactNode;
}

export function PublicSignalCard({
  title,
  badges,
  children,
}: PublicSignalCardProps) {
  return (
    <article className="rounded-xl border border-border/50 bg-card/60 p-5 dark:bg-card/30">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold tracking-tight text-foreground">{title}</h3>
        {badges ? <div className="flex flex-wrap gap-2">{badges}</div> : null}
      </div>
      <div className="mt-4 space-y-4">{children}</div>
    </article>
  );
}
