"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface EmptyStateStep {
  title: string;
  description: string;
}

interface EmptyStateSurfaceProps {
  eyebrow: string;
  title: string;
  description: ReactNode;
  steps?: readonly EmptyStateStep[];
  actions?: ReactNode;
  preview?: ReactNode;
  footnote?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function EmptyStateSurface({
  eyebrow,
  title,
  description,
  steps = [],
  actions,
  preview,
  footnote,
  children,
  className,
}: EmptyStateSurfaceProps) {
  return (
    <section
      className={cn(
        "pharos-card-shell w-full max-w-full min-w-0 overflow-hidden px-4 py-5 sm:px-6 sm:py-6",
        className,
      )}
    >
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(18rem,0.9fr)] lg:items-start">
        <div className="min-w-0 space-y-5">
          <div className="space-y-3">
            <p className="pharos-kicker text-primary/80">{eyebrow}</p>
            <div className="space-y-2">
              <h2 className="max-w-2xl text-2xl font-semibold tracking-tight text-foreground sm:text-[2rem] sm:leading-[1.05]">
                {title}
              </h2>
              <div className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</div>
            </div>
          </div>

          {steps.length > 0 ? (
            <ol className="grid divide-y divide-border/50 border-y border-border/50 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              {steps.map((step, index) => (
                <li key={step.title} className="py-3 sm:px-4 sm:first:pl-0 sm:last:pr-0">
                  <p className="pharos-kicker text-primary/80">0{index + 1}</p>
                  <p className="mt-2 text-sm font-semibold text-foreground">{step.title}</p>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{step.description}</p>
                </li>
              ))}
            </ol>
          ) : null}

          {actions}
          {children}
          {footnote ? (
            <div className="border-t border-border/50 pt-3 text-sm text-muted-foreground">
              {footnote}
            </div>
          ) : null}
        </div>

        {preview ? (
          <div className="min-w-0 border-t border-border/50 pt-5 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
            {preview}
          </div>
        ) : null}
      </div>
    </section>
  );
}
