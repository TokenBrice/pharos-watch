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
        "rounded-[1.5rem] border border-border/70 px-4 py-5 shadow-[0_22px_60px_oklch(0_0_0_/0.22)] sm:px-6 sm:py-6",
        className,
      )}
      style={{ background: "var(--surface-onboarding-gradient)" }}
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(18rem,0.9fr)] lg:items-start">
        <div className="space-y-5">
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
            <ol className="grid gap-3 sm:grid-cols-3">
              {steps.map((step, index) => (
                <li key={step.title} className="rounded-2xl border border-border/60 bg-background/45 px-4 py-3">
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
            <div className="rounded-2xl border border-border/60 bg-background/35 px-4 py-3 text-sm text-muted-foreground">
              {footnote}
            </div>
          ) : null}
        </div>

        {preview ? (
          <div className="rounded-[1.35rem] border border-border/70 bg-background/60 p-4 shadow-[inset_0_1px_0_oklch(1_0_0_/0.06)]">
            {preview}
          </div>
        ) : null}
      </div>
    </section>
  );
}
