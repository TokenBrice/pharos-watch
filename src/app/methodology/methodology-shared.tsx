import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export const METHODOLOGY_LINK_CLASS =
  "text-foreground/70 underline underline-offset-2 hover:text-foreground transition-colors";

export const METHODOLOGY_SECTIONS = [
  { id: "lifecycle-phases-methodology", label: "Lifecycle Phases" },
  { id: "pricing-pipeline-methodology", label: "Pricing Pipeline" },
  { id: "stability-index-methodology", label: "Stability Index" },
  { id: "safety-scores-methodology", label: "Safety Scores" },
  { id: "mint-authority-score", label: "Mint Authority Score" },
  { id: "infrastructure-methodology", label: "Infrastructure" },
  { id: "liquidity-methodology", label: "Liquidity Score" },
  { id: "mint-burn-flow-methodology", label: "Mint/Burn Flow" },
  { id: "yield-intelligence-methodology", label: "Yield Intelligence" },
  { id: "pegscore-dews-methodology", label: "PegScore + DEWS" },
  { id: "depeg-resolver-methodology", label: "Depeg Duration Resolver" },
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
  versionBadge,
  changelogPath,
  versionNote,
  changelogClassName,
  children,
}: {
  id: string;
  title: string;
  versionBadge?: { label: string };
  changelogPath?: string;
  versionNote?: string;
  changelogClassName?: string;
  children: ReactNode;
}) {
  return (
    <Card
      id={id}
      className="scroll-mt-36 rounded-xl border border-border/70 bg-card md:scroll-mt-28"
    >
      <CardHeader className={versionNote ? "space-y-2" : undefined}>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle as="h2">{title}</CardTitle>
          {versionBadge && (
            <span className="inline-flex items-center rounded-md border border-border bg-muted px-2 py-0.5 text-xs pharos-numeric font-semibold text-foreground">
              {versionBadge.label}
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
      className="group rounded-xl border border-border/60 bg-background/45"
    >
      <summary className="pharos-focus-ring cursor-pointer rounded-xl px-4 py-3.5 text-sm font-semibold text-foreground">{summary}</summary>
      <div className="space-y-6 border-t border-border/50 px-4 pb-5 pt-4">{children}</div>
    </details>
  );
}

export function MethodologyFacts({ facts }: { facts: Array<{ label: string; value: string }> }) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {facts.map((fact) => (
        <div key={fact.label} className="rounded-xl border border-border/60 bg-background/45 px-4 py-3">
          <p className="pharos-kicker">{fact.label}</p>
          <p className={cn("mt-2 text-sm text-foreground", /^\d/.test(fact.value) && "pharos-numeric")}>
            {fact.value}
          </p>
        </div>
      ))}
    </div>
  );
}

export function WorkedExample({ children, summary }: { children: ReactNode; summary: string }) {
  return (
    <details data-methodology-worked-example="true" className="rounded-xl border border-border/60 bg-background/80">
      <summary className="pharos-focus-ring cursor-pointer rounded-xl px-4 py-3.5 text-sm font-semibold text-foreground">{summary}</summary>
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
}: {
  direction?: "down" | "right";
}) {
  return (
    <div
      aria-hidden="true"
      className={
        direction === "right"
          ? "flex items-center text-xl font-bold text-muted-foreground"
          : "text-xl font-bold text-muted-foreground"
      }
    >
      {direction === "right" ? "\u2192" : "\u2193"}
    </div>
  );
}

export type MethodologyDiagramInput = {
  title: ReactNode;
  shortTitle?: ReactNode;
  subtitle?: ReactNode;
};

export type MethodologyDiagramStep = {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Static accent classes for the desktop card (e.g. fixed width, accent border). */
  className?: string;
};

const DIAGRAM_GRID_COLS: Record<2 | 4, string> = {
  2: "grid grid-cols-2 gap-2 w-full md:gap-3",
  4: "grid grid-cols-2 gap-2 w-full md:grid-cols-4 md:gap-3",
};

/**
 * Renders the shared methodology "inputs grid -> stacked steps" flow diagram with a
 * single responsive layout instead of duplicated desktop/mobile subtrees. Inputs render
 * in a responsive grid; each step renders as a stacked card separated by down arrows.
 */
export function MethodologyDiagramFlow({
  inputs,
  inputCols,
  inputGridClassName,
  steps,
}: {
  inputs: MethodologyDiagramInput[];
  inputCols: 2 | 4;
  /** Extra static classes for the inputs grid wrapper (e.g. md:max-w-md centering). */
  inputGridClassName?: string;
  steps: MethodologyDiagramStep[];
}) {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className={cn(DIAGRAM_GRID_COLS[inputCols], inputGridClassName)}>
        {inputs.map((input, index) => (
          <MethodologyDiagramCard
            key={index}
            title={
              input.shortTitle ? (
                <>
                  <span className="md:hidden">{input.shortTitle}</span>
                  <span className="hidden md:inline">{input.title}</span>
                </>
              ) : (
                input.title
              )
            }
            titleClassName="text-xs md:text-base"
            subtitle={input.subtitle}
          />
        ))}
      </div>
      {steps.map((step, index) => (
        <Fragment key={index}>
          <MethodologyDiagramArrow />
          <MethodologyDiagramCard
            className={cn("w-full", step.className)}
            title={step.title}
            subtitle={step.subtitle}
          />
        </Fragment>
      ))}
    </div>
  );
}
