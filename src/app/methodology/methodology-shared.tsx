import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import { ArrowDown, ArrowRight } from "lucide-react";
import { DisclosurePanel } from "@/components/disclosure-panel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export const METHODOLOGY_LINK_CLASS = "pharos-prose-link text-foreground/85";

const METHODOLOGY_PROSE_SCOPE_CLASS =
  "[&_p]:max-w-[72ch] [&_ul]:max-w-[72ch] [&_ol]:max-w-[72ch] [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:tracking-tight [&_h3]:text-foreground [&_p_code]:rounded-sm [&_p_code]:bg-muted/70 [&_p_code]:px-1 [&_p_code]:py-0.5 [&_p_code]:font-mono [&_p_code]:text-xs [&_p_code]:text-foreground [&_li_code]:rounded-sm [&_li_code]:bg-muted/70 [&_li_code]:px-1 [&_li_code]:py-0.5 [&_li_code]:font-mono [&_li_code]:text-xs [&_li_code]:text-foreground [&_dd_code]:rounded-sm [&_dd_code]:bg-muted/70 [&_dd_code]:px-1 [&_dd_code]:py-0.5 [&_dd_code]:font-mono [&_dd_code]:text-xs [&_dd_code]:text-foreground [&_td_code]:rounded-sm [&_td_code]:bg-muted/70 [&_td_code]:px-1 [&_td_code]:py-0.5 [&_td_code]:font-mono [&_td_code]:text-xs [&_td_code]:text-foreground";

export const METHODOLOGY_READING_STEPS = [
  {
    label: "Summary",
    description: "Model purpose and the core signal to scan first.",
  },
  {
    label: "Quick facts",
    description: "Cadence, score range, dependencies, and failure behavior.",
  },
  {
    label: "Worked examples",
    description: "Real inputs run through the same functions used in production.",
  },
  {
    label: "Technical notes",
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
  liveHref,
  liveLabel,
  docsPath,
  children,
}: {
  id: string;
  title: string;
  versionBadge?: { label: string };
  changelogPath?: string;
  versionNote?: string;
  changelogClassName?: string;
  liveHref?: string;
  liveLabel?: string;
  docsPath?: string;
  children: ReactNode;
}) {
  const hasMetaLinks = Boolean(liveHref || docsPath || changelogPath);

  return (
    <Card id={id} variant="shell" className="scroll-mt-36">
      <CardHeader className="space-y-2 border-b border-border/50 pb-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle as="h2" className="pharos-section-title">
              {title}
            </CardTitle>
            {versionBadge && (
              <span className="inline-flex items-center rounded-md border border-border/70 bg-muted/60 px-2 py-0.5 text-xs pharos-numeric font-semibold text-foreground">
                {versionBadge.label}
              </span>
            )}
          </div>
          {hasMetaLinks && (
            <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs">
              {liveHref && (
                <Link
                  href={liveHref}
                  className="pharos-focus-ring rounded-sm whitespace-nowrap text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground"
                >
                  {liveLabel ?? "Live view"}
                  {"\u00a0\u2192"}
                </Link>
              )}
              {docsPath && (
                <Link
                  href={docsPath}
                  className="pharos-focus-ring rounded-sm whitespace-nowrap text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground"
                >
                  Technical spec{"\u00a0\u2192"}
                </Link>
              )}
              {changelogPath && (
                <Link
                  href={changelogPath}
                  className={cn(
                    "pharos-focus-ring rounded-sm whitespace-nowrap text-foreground underline underline-offset-4 transition-colors",
                    changelogClassName,
                  )}
                >
                  Version history{"\u00a0\u2192"}
                </Link>
              )}
            </div>
          )}
        </div>
        {versionNote && (
          <p className="max-w-[72ch] text-xs leading-relaxed text-muted-foreground">{versionNote}</p>
        )}
      </CardHeader>
      <CardContent
        className={cn("space-y-6 text-sm leading-relaxed text-muted-foreground", METHODOLOGY_PROSE_SCOPE_CLASS)}
      >
        {children}
      </CardContent>
    </Card>
  );
}

export function MethodologyFormula({
  children,
  className,
  preformatted = false,
}: {
  children: ReactNode;
  className?: string;
  preformatted?: boolean;
}) {
  const baseClass =
    "overflow-x-auto rounded-lg border border-border/60 bg-muted/40 px-4 py-3 text-xs leading-relaxed text-foreground pharos-numeric";

  if (preformatted) {
    return <pre className={cn(baseClass, className)}>{children}</pre>;
  }

  return <div className={cn(baseClass, className)}>{children}</div>;
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
    <DisclosurePanel
      data-methodology-details="true"
      data-methodology-primary={primary ? "true" : undefined}
      open={defaultOpen}
      variant="inset"
      summary={summary}
      summaryClassName="font-semibold"
      contentClassName={cn("space-y-6 pb-5 pt-4", METHODOLOGY_PROSE_SCOPE_CLASS)}
    >
      {children}
    </DisclosurePanel>
  );
}

export interface MethodologyFactItem {
  label: string;
  value: ReactNode;
  numeric?: boolean;
}

function isCompactNumericFact(value: ReactNode, explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return typeof value === "string" && value.length <= 24 && /^[\d$v+−-]/.test(value);
}

function factsGridClass(count: number): string {
  if (count === 2) return "grid gap-3 sm:grid-cols-2";
  if (count === 4) return "grid gap-3 sm:grid-cols-2 lg:grid-cols-4";
  return "grid gap-3 sm:grid-cols-3";
}

export function MethodologyFacts({
  facts,
  layout = "grid",
}: {
  facts: readonly MethodologyFactItem[];
  layout?: "grid" | "list";
}) {
  if (layout === "list") {
    return (
      <dl className="pharos-inset divide-y divide-border/50 px-4 text-xs">
        {facts.map((fact) => (
          <div
            key={fact.label}
            className="grid gap-1 py-2.5 sm:grid-cols-[15rem_minmax(0,1fr)] sm:gap-4"
          >
            <dt className="font-medium text-foreground">{fact.label}</dt>
            <dd
              className={cn(
                "leading-relaxed text-muted-foreground",
                isCompactNumericFact(fact.value, fact.numeric) && "pharos-numeric text-foreground",
              )}
            >
              {fact.value}
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  return (
    <div className={factsGridClass(facts.length)}>
      {facts.map((fact) => (
        <div key={fact.label} className="pharos-inset px-4 py-3">
          <p className="pharos-label">{fact.label}</p>
          <p
            className={cn(
              "mt-2 text-sm text-foreground",
              isCompactNumericFact(fact.value, fact.numeric) && "pharos-numeric",
            )}
          >
            {fact.value}
          </p>
        </div>
      ))}
    </div>
  );
}

export function MethodologyPreconditions({
  facts,
  variant = "compact",
}: {
  facts: readonly MethodologyFactItem[];
  variant?: "normal" | "compact";
}) {
  if (variant === "normal") {
    return (
      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Preconditions &amp; failure modes</h3>
        <MethodologyFacts facts={facts} />
      </div>
    );
  }

  return (
    <div className="space-y-2.5 rounded-lg border border-border/60 bg-muted/20 p-4">
      <h3 className="text-foreground font-medium">Preconditions &amp; failure modes</h3>
      <dl className="divide-y divide-border/40 text-xs">
        {facts.map((fact) => (
          <div
            key={fact.label}
            className="grid gap-1 py-2 first:pt-0 last:pb-0 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-3"
          >
            <dt className="font-medium text-foreground">{fact.label}</dt>
            <dd className="leading-relaxed text-muted-foreground">{fact.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function WorkedExample({ children, summary }: { children: ReactNode; summary: string }) {
  return (
    <DisclosurePanel
      data-methodology-worked-example="true"
      variant="band"
      summary={
        <span className="flex flex-wrap items-center gap-2">
          <span className="pharos-label rounded-sm border border-border/60 bg-background/70 px-1.5 py-0.5 text-2xs">
            Example
          </span>
          <span className="font-semibold text-foreground">{summary}</span>
        </span>
      }
      contentClassName="space-y-2 pb-4 pt-4 text-sm leading-relaxed text-muted-foreground"
    >
      {children}
    </DisclosurePanel>
  );
}

type MethodologyPipelineCardClasses = readonly [card: string, title: string, subtitle?: string];

export type MethodologyDiagramCardProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  className?: string;
  titleClassName?: string;
  subtitleClassName?: string;
  emphasis?: "output";
  footer?: { className: string; content: ReactNode };
  exactClassNames?: MethodologyPipelineCardClasses;
};

function MethodologyDiagramCard({
  title,
  subtitle,
  className,
  titleClassName,
  subtitleClassName,
  emphasis,
  footer,
  exactClassNames,
}: MethodologyDiagramCardProps) {
  return (
    <div
      className={
        exactClassNames?.[0] ??
        cn(
          "pharos-inset p-3 text-center",
          emphasis === "output" && "border-foreground/25 bg-muted/40",
          className,
        )
      }
    >
      <div className={exactClassNames?.[1] ?? cn("text-sm font-medium text-foreground", titleClassName)}>
        {title}
      </div>
      {subtitle ? (
        <div className={exactClassNames?.[2] ?? cn("mt-0.5 text-xs text-muted-foreground", subtitleClassName)}>
          {subtitle}
        </div>
      ) : null}
      {footer ? <div className={footer.className}>{footer.content}</div> : null}
    </div>
  );
}

function MethodologyDiagramArrow({ direction = "down" }: { direction?: "down" | "right" }) {
  return (
    <div
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center text-muted-foreground"
    >
      {direction === "right" ? (
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      ) : (
        <ArrowDown className="h-4 w-4" aria-hidden="true" />
      )}
    </div>
  );
}

export type ResponsiveMethodologyPipelineCard = MethodologyDiagramCardProps;

export type ResponsiveMethodologyPipelineStage = {
  wrapperClassName?: string;
  cards: ResponsiveMethodologyPipelineCard[];
  exactClassNames?: MethodologyPipelineCardClasses;
};

export type ResponsiveMethodologyPipelineLayout = {
  wrapperClassName: string;
  arrow: { className: string; symbol: "→" | "↓"; ariaHidden?: boolean };
  stages: ResponsiveMethodologyPipelineStage[];
  exactClassNames?: MethodologyPipelineCardClasses;
};

export type ResponsiveMethodologyPipelineProps = {
  desktop: ResponsiveMethodologyPipelineLayout;
  mobile: ResponsiveMethodologyPipelineLayout;
};

function ResponsiveMethodologyPipelineLayout({ layout }: { layout: ResponsiveMethodologyPipelineLayout }) {
  const arrowDirection = layout.arrow.symbol === "→" ? "right" : "down";
  return (
    <div className={layout.wrapperClassName}>
      {layout.stages.map((stage, index) => {
        const cards = stage.cards.map((card, cardIndex) => (
          <MethodologyDiagramCard
            key={cardIndex}
            {...card}
            exactClassNames={card.exactClassNames ?? stage.exactClassNames ?? layout.exactClassNames}
          />
        ));
        return (
          <Fragment key={index}>
            {stage.wrapperClassName ? <div className={stage.wrapperClassName}>{cards}</div> : cards}
            {index < layout.stages.length - 1 ? <MethodologyDiagramArrow direction={arrowDirection} /> : null}
          </Fragment>
        );
      })}
    </div>
  );
}

export function ResponsiveMethodologyPipeline({ desktop, mobile }: ResponsiveMethodologyPipelineProps) {
  return (
    <>
      <ResponsiveMethodologyPipelineLayout layout={desktop} />
      <ResponsiveMethodologyPipelineLayout layout={mobile} />
    </>
  );
}

export type MethodologyDiagramInput = {
  title: ReactNode;
  shortTitle?: ReactNode;
  subtitle?: ReactNode;
  itemClassName?: string;
};

export type MethodologyDiagramStep = {
  title: ReactNode;
  subtitle?: ReactNode;
  emphasis?: "output";
  /** Static classes for the step card (e.g. fixed desktop width). */
  className?: string;
};

const DIAGRAM_GRID_COLS: Record<2 | 4 | 5, string> = {
  2: "grid grid-cols-2 gap-2 w-full md:gap-3",
  4: "grid grid-cols-2 gap-2 w-full md:grid-cols-4 md:gap-3",
  5: "grid grid-cols-2 gap-2 w-full md:grid-cols-5 md:gap-3",
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
  inputCols: 2 | 4 | 5;
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
            className={input.itemClassName}
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
            titleClassName="text-xs md:text-sm"
            subtitle={input.subtitle}
          />
        ))}
      </div>
      {steps.map((step, index) => (
        <Fragment key={index}>
          <MethodologyDiagramArrow />
          <MethodologyDiagramCard
            className={cn("w-full", step.className)}
            emphasis={step.emphasis}
            title={step.title}
            subtitle={step.subtitle}
          />
        </Fragment>
      ))}
    </div>
  );
}
