import { Fragment, useRef, type ReactNode } from "react";
import { ChevronDown, ExternalLink } from "lucide-react";
import type { FailureScenarioStage } from "@shared/types/failure-scenarios";
import { formatAddress } from "@shared/lib/format";
import { SECTION_SCROLL_MT } from "@/components/stablecoin-detail/section-title-class";
import { cn } from "@/lib/utils";
import {
  CitationLinks,
  EvidenceGlyph,
  EvidenceMarker,
  KeysPill,
  MissingDefenseMark,
  StepNumber,
} from "./scenario-glyphs";
import {
  EVIDENCE_LABEL,
  EVIDENCE_ORDER,
  buildTargetExplorerUrl,
  isHypotheticalStage,
  resolveCitations,
  stepAnchorId,
  type NumberedSource,
  type RouteStep,
  type ScenarioRoute,
} from "./scenario-model";

/**
 * Breaks a call path after each dot, open paren and comma before falling back
 * to breaking anywhere, so a long call wraps between identifiers on a phone
 * instead of mid-name. Plain string scanning, no regex literal: Tailwind's
 * source scanner misreads regex character classes and drops the file's
 * utility classes.
 */
function withBreakPoints(text: string): ReactNode {
  const parts: string[] = [];
  let current = "";
  for (const char of text) {
    current += char;
    if (char === "." || char === "(" || char === ",") {
      parts.push(current);
      current = "";
    }
  }
  if (current) parts.push(current);
  return parts.map((part, index) => (
    <Fragment key={index}>
      {index > 0 ? <wbr /> : null}
      {part}
    </Fragment>
  ));
}

function CallPath({ action }: { action: string }) {
  const hops = action.split("→").map((hop) => hop.trim()).filter((hop) => hop.length > 0);
  return (
    <code className="block rounded-md bg-muted/60 px-2 py-1.5 font-mono text-[12px] leading-relaxed text-foreground [overflow-wrap:anywhere]">
      {hops.map((hop, index) => (
        <Fragment key={`${index}:${hop}`}>
          {index > 0 ? <span className="text-muted-foreground"> → </span> : null}
          {withBreakPoints(hop)}
        </Fragment>
      ))}
    </code>
  );
}

function StageTargets({ stage }: { stage: FailureScenarioStage }) {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-0.5">
      {stage.targets?.map((target) => {
        const href = buildTargetExplorerUrl(target.address, target.chainId);
        const body = (
          <>
            <span className="text-foreground/90">{target.label}</span>{" "}
            <span className="pharos-numeric text-[11px] text-muted-foreground">{formatAddress(target.address, 6, 4)}</span>
          </>
        );
        return (
          <li key={`${target.chainId}:${target.address}`}>
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                title={target.address}
                className="pharos-focus-ring group inline-flex min-h-6 flex-wrap items-center gap-x-1.5 rounded-sm text-[13px] hover:underline hover:underline-offset-2"
              >
                {body}
                <ExternalLink aria-hidden="true" className="h-3 w-3 shrink-0 text-muted-foreground group-hover:text-foreground" />
              </a>
            ) : (
              <span title={target.address} className="inline-flex min-h-6 items-center gap-1.5 text-[13px]">
                {body}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const FACT_LABEL_CLASS = "pt-px text-xs text-muted-foreground";

/**
 * One step as a native disclosure. Collapsed it is one line: number, title,
 * the missing defense (truncated), evidence glyph and elapsed time; below the
 * row's own 32rem the line wraps under the title. Open, the defense wraps in
 * full and the body adds the explanation, actor, call, contracts, cost and
 * sources. The `<details>` owns the step anchor, so a hash jump (which
 * `anchor-reveal.ts` resolves by opening enclosing disclosures) lands on it
 * open.
 */
function StepRow({
  step,
  terminal,
  numberedSources,
  anchorPrefix,
}: {
  step: RouteStep;
  terminal: boolean;
  numberedSources: ReadonlyMap<string, NumberedSource>;
  anchorPrefix: string;
}) {
  const { stage } = step;
  const hypothetical = isHypotheticalStage(stage);
  const hasTargets = (stage.targets?.length ?? 0) > 0;

  return (
    <li>
      <details
        id={stepAnchorId(anchorPrefix, stage.id)}
        data-scenario-step=""
        className={cn("group/step rounded-md open:bg-muted/30", SECTION_SCROLL_MT)}
      >
        <summary className="pharos-focus-ring grid min-h-11 cursor-pointer list-none grid-cols-[1.75rem_minmax(0,1fr)_1rem] items-start gap-x-2 rounded-md px-2 py-2 transition-colors hover:bg-muted/40 lg:min-h-9 [&::-webkit-details-marker]:hidden">
          <StepNumber number={step.number} hypothetical={hypothetical} terminal={terminal} />
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5 @lg/steps:flex-nowrap">
            <span className="order-1 basis-full text-sm font-medium leading-5 text-foreground text-pretty @lg/steps:max-w-[42%] @lg/steps:shrink-0 @lg/steps:basis-auto">
              {stage.title}
              {hypothetical ? <span className="sr-only">, hypothetical step</span> : null}
            </span>
            <span className="order-2 inline-flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground @lg/steps:order-4">
              <EvidenceGlyph evidence={stage.evidence} />
              <span className="sr-only">{EVIDENCE_LABEL[stage.evidence]}, </span>
              <span className="pharos-numeric text-pretty">{stage.elapsed}</span>
            </span>
            {stage.missingDefense ? (
              <span className="order-3 flex min-w-0 flex-1 items-start gap-1.5 text-xs leading-5 text-foreground/75">
                <MissingDefenseMark size="sm" className="mt-0.5" />
                <span className="sr-only">Missing defense: </span>
                <span className="line-clamp-2 min-w-0 @lg/steps:line-clamp-1 group-open/step:line-clamp-none group-open/step:text-pretty">
                  {stage.missingDefense}
                </span>
              </span>
            ) : (
              <span aria-hidden="true" className="order-3 hidden flex-1 @lg/steps:block" />
            )}
          </span>
          <ChevronDown
            aria-hidden="true"
            className="mt-1 h-3.5 w-3.5 text-muted-foreground transition-transform motion-reduce:transition-none group-open/step:rotate-180"
          />
        </summary>

        {/* Wide rows split: explanation and evidence left, facts right. */}
        <div className="grid gap-3 px-2 pb-4 pt-1 @lg/steps:pl-[2.75rem] @lg/steps:pr-8 @2xl/steps:grid-cols-2 @2xl/steps:gap-x-8">
          <div className="min-w-0 space-y-3">
            <p className="text-sm leading-relaxed text-foreground/85 text-pretty">{stage.explanation}</p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <EvidenceMarker evidence={stage.evidence} />
              <CitationLinks sources={resolveCitations(stage.sourceIds, numberedSources)} />
            </div>
          </div>
          <dl className="grid min-w-0 grid-cols-[4.25rem_minmax(0,1fr)] content-start gap-x-3 gap-y-1.5 text-[13px] leading-relaxed">
            <dt className={FACT_LABEL_CLASS}>Actor</dt>
            <dd className="min-w-0 text-foreground/90">{stage.actor}</dd>
            <dt className={cn(FACT_LABEL_CLASS, stage.actionIsCode && "pt-1.5")}>{stage.actionIsCode ? "Call" : "Action"}</dt>
            <dd className="min-w-0">
              {stage.actionIsCode ? <CallPath action={stage.action} /> : <span className="text-foreground/90">{stage.action}</span>}
            </dd>
            {hasTargets ? (
              <>
                <dt className={cn(FACT_LABEL_CLASS, "pt-1")}>{stage.targets?.length === 1 ? "Contract" : "Contracts"}</dt>
                <dd className="min-w-0">
                  <StageTargets stage={stage} />
                </dd>
              </>
            ) : null}
            <dt className={FACT_LABEL_CLASS}>Cost</dt>
            <dd className="min-w-0 text-foreground/90">{stage.cost}</dd>
          </dl>
        </div>
      </details>
    </li>
  );
}

function StepList({
  steps,
  route,
  numberedSources,
  anchorPrefix,
  label,
}: {
  steps: readonly RouteStep[];
  route: ScenarioRoute;
  numberedSources: ReadonlyMap<string, NumberedSource>;
  anchorPrefix: string;
  label?: string;
}) {
  return (
    <ol aria-label={label} className="@container/steps min-w-0 space-y-px">
      {steps.map((step) => (
        <StepRow
          key={step.stage.id}
          step={step}
          terminal={step.stage.id === route.terminalStageId}
          numberedSources={numberedSources}
          anchorPrefix={anchorPrefix}
        />
      ))}
    </ol>
  );
}

const CONNECTIVE_CLASS = "flex items-center gap-3 px-2 pt-3 pb-1.5 text-xs font-medium text-muted-foreground";

/**
 * The detail layer: every step, collapsed to one line, in path order. The
 * alternative routes sit in side-by-side columns from 56rem (each headed by
 * its label, key threshold and route premise) and stack below it.
 * Expand all / Collapse all drive the native disclosures directly.
 */
export function ScenarioSteps({
  route,
  numberedSources,
  anchorPrefix,
  sharedLabel,
  headingId,
}: {
  route: ScenarioRoute;
  numberedSources: ReadonlyMap<string, NumberedSource>;
  anchorPrefix: string;
  sharedLabel: string;
  headingId: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const setAllOpen = (open: boolean) => {
    listRef.current?.querySelectorAll<HTMLDetailsElement>("details[data-scenario-step]").forEach((details) => {
      details.open = open;
    });
  };
  const controlClass =
    "pharos-focus-ring inline-flex min-h-8 items-center rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground";

  return (
    <section aria-labelledby={headingId} className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <h4 id={headingId} className="text-sm font-semibold tracking-tight text-foreground">
          Step by step{" "}
          <span className="font-normal text-muted-foreground">
            · <span className="pharos-numeric">{route.steps.length}</span> steps, each with its evidence
          </span>
        </h4>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setAllOpen(true)} className={controlClass}>
            Expand all
          </button>
          <span aria-hidden="true" className="text-muted-foreground/50">·</span>
          <button type="button" onClick={() => setAllOpen(false)} className={controlClass}>
            Collapse all
          </button>
        </div>
      </div>
      <ul aria-label="Legend" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        {EVIDENCE_ORDER.map((evidence) => (
          <li key={evidence} className="inline-flex items-center gap-1.5">
            <EvidenceGlyph evidence={evidence} />
            {EVIDENCE_LABEL[evidence]}
          </li>
        ))}
        <li className="inline-flex items-center gap-1.5">
          <MissingDefenseMark size="sm" />
          Missing defense
        </li>
        <li className="inline-flex items-center gap-1.5">
          <StepNumber label="" hypothetical terminal={false} className="h-3.5 min-w-3.5" />
          Hypothetical step
        </li>
      </ul>

      <div ref={listRef} className="min-w-0 border-t border-border/50 pt-1">
        <StepList steps={route.pre} route={route} numberedSources={numberedSources} anchorPrefix={anchorPrefix} />
        {route.lanes.length > 0 ? (
          <>
            <p className={CONNECTIVE_CLASS}>
              <span>Then one of {route.lanes.length} routes</span>
              <span aria-hidden="true" className="h-px flex-1 bg-border/60" />
            </p>
            <div className="grid gap-x-6 gap-y-4 @4xl/evidence:grid-cols-[repeat(auto-fit,minmax(24rem,1fr))]">
              {route.lanes.map((lane) => (
                <div
                  key={lane.branch.id}
                  role="group"
                  aria-labelledby={`${anchorPrefix}-route-${lane.branch.id}`}
                  className="min-w-0"
                >
                  <div className="space-y-1 border-b border-border/50 px-2 pb-2.5 pt-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <span id={`${anchorPrefix}-route-${lane.branch.id}`} className="text-sm font-semibold text-foreground">
                        {lane.branch.label}
                      </span>
                      <KeysPill>{lane.branch.keys}</KeysPill>
                    </p>
                    <p className="text-xs leading-relaxed text-muted-foreground text-pretty">
                      {lane.branch.premise}
                    </p>
                  </div>
                  <StepList
                    steps={lane.steps}
                    route={route}
                    numberedSources={numberedSources}
                    anchorPrefix={anchorPrefix}
                  />
                </div>
              ))}
            </div>
            <p className={CONNECTIVE_CLASS}>
              <span>{sharedLabel} rejoin</span>
              <span aria-hidden="true" className="h-px flex-1 bg-border/60" />
            </p>
            <StepList steps={route.post} route={route} numberedSources={numberedSources} anchorPrefix={anchorPrefix} />
          </>
        ) : null}
      </div>
    </section>
  );
}
