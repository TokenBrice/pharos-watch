import type { ReactNode } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export const METHODOLOGY_SECTIONS = [
  { id: "pricing-pipeline-methodology", label: "Pricing Pipeline" },
  { id: "stability-index-methodology", label: "Stability Index" },
  { id: "safety-scores-methodology", label: "Safety Scores" },
  { id: "infrastructure-methodology", label: "Infrastructure" },
  { id: "liquidity-methodology", label: "Liquidity Score" },
  { id: "mint-burn-flow-methodology", label: "Mint/Burn Flow" },
  { id: "yield-intelligence-methodology", label: "Yield Intelligence" },
  { id: "pegscore-dews-methodology", label: "PegScore + DEWS" },
  { id: "contagion-stress-test-methodology", label: "Contagion Test" },
  { id: "blacklist-tracker-methodology", label: "Blacklist Tracker" },
  { id: "chain-health-score", label: "Chain Health Score" },
] as const;

export const METHODOLOGY_READING_STEPS = [
  {
    label: "Summary",
    description: "Model purpose and the core signal to scan first.",
  },
  {
    label: "Quick Facts",
    description: "Cadence, score range, dependencies, and failure behavior.",
  },
  {
    label: "Worked Examples",
    description: "Real inputs run through the same functions used in production.",
  },
  {
    label: "Technical Notes",
    description: "Expanded formulas, caveats, and changelog links when you need them.",
  },
] as const;

export const READER_GUIDE_COPY =
  "Reader mode keeps summaries up front. Switch to Analyst for formulas, caveats, and worked examples.";

export function MethodologySectionShell({
  id,
  title,
  versionLabel,
  changelogPath,
  versionNote,
  accentClassName,
  badgeClassName,
  changelogClassName,
  children,
}: {
  id: string;
  title: string;
  versionLabel?: string;
  changelogPath?: string;
  versionNote?: string;
  accentClassName: string;
  badgeClassName?: string;
  changelogClassName?: string;
  children: ReactNode;
}) {
  return (
    <Card
      id={id}
      className={cn("scroll-mt-36 rounded-xl border border-border/70 border-l-[3px] bg-card md:scroll-mt-28", accentClassName)}
    >
      <CardHeader className={versionNote ? "space-y-2" : undefined}>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle as="h2">{title}</CardTitle>
          {versionLabel && badgeClassName && (
            <span className={cn("inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono font-semibold", badgeClassName)}>
              {versionLabel}
            </span>
          )}
          {changelogPath && (
            <Link
              href={changelogPath}
              className={cn("text-xs text-foreground underline underline-offset-4 transition-colors", changelogClassName)}
            >
              Version history &rarr;
            </Link>
          )}
        </div>
        {versionNote && <p className="text-xs text-muted-foreground">{versionNote}</p>}
      </CardHeader>
      <CardContent className="space-y-6 text-sm leading-relaxed text-muted-foreground">{children}</CardContent>
    </Card>
  );
}

export function MethodologyDetails({
  children,
  summary,
  defaultOpen = false,
  primary = false,
}: {
  children: ReactNode;
  summary: string;
  defaultOpen?: boolean;
  primary?: boolean;
}) {
  return (
    <details
      data-methodology-details="true"
      data-methodology-primary={primary ? "true" : undefined}
      open={defaultOpen}
      className="group rounded-2xl border border-border/60 bg-background/45 shadow-[inset_0_1px_0_oklch(1_0_0_/0.04)]"
    >
      <summary className="pharos-focus-ring cursor-pointer rounded-2xl px-4 py-3.5 text-sm font-semibold text-foreground">{summary}</summary>
      <div className="space-y-6 border-t border-border/50 px-4 pb-5 pt-4">{children}</div>
    </details>
  );
}

export function MethodologyFacts({ facts }: { facts: Array<{ label: string; value: string }> }) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {facts.map((fact) => (
        <div key={fact.label} className="rounded-2xl border border-border/60 bg-background/45 px-4 py-3">
          <p className="pharos-kicker">{fact.label}</p>
          <p className="mt-2 text-sm text-foreground">{fact.value}</p>
        </div>
      ))}
    </div>
  );
}

export function WorkedExample({ children, summary }: { children: ReactNode; summary: string }) {
  return (
    <details data-methodology-worked-example="true" className="rounded-2xl border border-border/60 bg-background/80">
      <summary className="pharos-focus-ring cursor-pointer rounded-2xl px-4 py-3.5 text-sm font-semibold text-foreground">{summary}</summary>
      <div className="space-y-2 border-t border-border/50 px-4 pb-4 pt-4 text-sm leading-relaxed text-muted-foreground">
        {children}
      </div>
    </details>
  );
}

export function MethodologyDiagramCard({
  title,
  subtitle,
  className,
  titleClassName,
  subtitleClassName,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  className?: string;
  titleClassName?: string;
  subtitleClassName?: string;
}) {
  return (
    <div className={cn("rounded-lg border p-3 text-center", className)}>
      <p className={cn("text-foreground font-medium", titleClassName)}>{title}</p>
      {subtitle ? (
        <p className={cn("mt-0.5 text-xs text-muted-foreground", subtitleClassName)}>{subtitle}</p>
      ) : null}
    </div>
  );
}

export function MethodologyDiagramArrow({
  direction = "down",
  className,
}: {
  direction?: "down" | "right";
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        direction === "right"
          ? "flex items-center text-xl font-bold text-muted-foreground"
          : "text-xl font-bold text-muted-foreground",
        className,
      )}
    >
      {direction === "right" ? "\u2192" : "\u2193"}
    </div>
  );
}
