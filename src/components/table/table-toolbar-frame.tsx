import * as React from "react";

import { cn } from "@/lib/utils";

export interface TableToolbarFrameProps {
  eyebrow?: React.ReactNode;
  description?: React.ReactNode;
  titleId?: string;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  titleClassName?: string;
  actionsClassName?: string;
}

export function TableToolbarFrame({
  eyebrow = "Table Controls",
  description,
  titleId,
  meta,
  actions,
  children,
  className,
  titleClassName,
  actionsClassName,
}: TableToolbarFrameProps) {
  return (
    <div className={cn("pharos-table-toolbar", className)}>
      <div className="flex flex-col gap-3 xl:flex-row xl:items-baseline xl:justify-between">
        <div className={cn("min-w-0 space-y-1 xl:flex-1", titleClassName)}>
          {titleId ? (
            <h2
              id={titleId}
              className="font-mono text-base font-semibold uppercase tracking-tight text-foreground sm:text-lg"
            >
              {eyebrow}
              {meta ? (
                <span className="ml-3 align-middle font-mono text-xs tabular-nums text-muted-foreground">
                  · {meta}
                </span>
              ) : null}
            </h2>
          ) : (
            <p className="pharos-kicker">{eyebrow}</p>
          )}
          {description ? (
            <p className="pharos-meta hidden sm:block">{description}</p>
          ) : null}
          {children}
        </div>
        {actions ? (
          <div className={cn("flex flex-wrap items-center gap-2 sm:justify-end", actionsClassName)}>
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}
