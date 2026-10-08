"use client";

import { useEffect, useMemo, type MouseEvent } from "react";
import {
  Circle,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  FilePen,
  FlaskConical,
  type LucideIcon,
} from "lucide-react";
import type {
  FailureScenario,
  FailureScenarioDefenderVerdict,
  FailureScenarioFalsifierStatus,
} from "@shared/types/failure-scenarios";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { EvidenceModule } from "@/components/stablecoin-detail/evidence-module";
import { FactGrid } from "@/components/stablecoin-detail/fact-grid";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { Badge } from "@/components/ui/badge";
import { findSummaryBudgetViolations, SUMMARY_PROSE_MAX_WORDS } from "@shared/lib/summary-budget";
import { revealAnchorId } from "@/lib/anchor-reveal";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";
import { RouteMap } from "./route-map";
import { ScenarioClock } from "./scenario-clock";
import { CitationLinks, EvidenceGlyph, EvidenceMarker, MissingDefenseMark, StepNumber } from "./scenario-glyphs";
import { ScenarioSteps } from "./scenario-steps";
import {
  DEFENDER_VERDICT_LABEL,
  EVIDENCE_LABEL,
  FALSIFIER_STATUS_LABEL,
  buildScenarioClock,
  buildScenarioRoute,
  formatBlock,
  numberSources,
  resolveCitations,
  stepAnchorId,
  type FailureScenarioSelection,
  type NumberedSource,
} from "./scenario-model";

/** Anchor of the module; steps anchor as `failure-scenario-<stageId>`. */
const FAILURE_SCENARIO_MODULE_ID = "failure-scenario";

const CHIP_CLASS = "text-[11px] font-medium";
const NEUTRAL_CHIP_CLASS = cn(CHIP_CLASS, SEVERITY_TONE_CLASS.neutral.pill);
const SUBHEADING_CLASS = "text-sm font-semibold tracking-tight text-foreground";

/**
 * Verdicts on who could stop the path. "Cannot stop it" is the one place the
 * scenario takes the error tone (owner ruling): it is the module's finding,
 * stated with a glyph and a label, never by hue alone. Partial stays neutral.
 */
const VERDICT_PRESENTATION: Record<FailureScenarioDefenderVerdict, { icon: LucideIcon; tone: string }> = {
  "cannot-stop": { icon: CircleX, tone: SEVERITY_TONE_CLASS.alert.text },
  partial: { icon: CircleMinus, tone: "text-foreground/80" },
  "can-stop": { icon: CircleCheck, tone: SEVERITY_TONE_CLASS.ok.text },
  unverified: { icon: CircleDashed, tone: "text-muted-foreground" },
};

const FALSIFIER_PRESENTATION: Record<FailureScenarioFalsifierStatus, { icon: LucideIcon; tone: string }> = {
  "not-met": { icon: Circle, tone: "text-muted-foreground" },
  met: { icon: CircleCheck, tone: SEVERITY_TONE_CLASS.alert.text },
  unverified: { icon: CircleDashed, tone: "text-muted-foreground" },
};

/** One slim line: the draft marker cannot be missed, and no longer dominates the module. */
function DraftNotice({ note }: { note?: string }) {
  return (
    <p
      role="note"
      aria-label="Draft scenario"
      className={cn(
        "flex items-start gap-2 rounded-md border border-dashed px-3 py-1.5 text-xs leading-relaxed text-foreground/85",
        SEVERITY_TONE_CLASS.watch.banner,
      )}
    >
      <FilePen aria-hidden="true" className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", SEVERITY_TONE_CLASS.watch.text)} />
      <span className="text-pretty">
        <span className={cn("font-semibold", SEVERITY_TONE_CLASS.watch.text)}>Draft, not approved:</span> development
        preview only.{note ? <> {note}</> : null}
      </span>
    </p>
  );
}

/**
 * The premise's first sentence, shown in the summary layer only when it fits
 * the always-visible prose budget and carries no raw identifier (an address
 * prefix such as `0x947B…` counts). Otherwise the summary shows no premise and
 * the full text opens the attack-path fold; the "Hypothetical scenario" chip
 * still frames the module.
 */
function summaryPremise(premise: string): string | null {
  const first = premise.split(/(?<=\.)\s+/)[0] ?? "";
  if (/\b0x[0-9a-f]/i.test(first)) return null;
  return findSummaryBudgetViolations(first, SUMMARY_PROSE_MAX_WORDS).length === 0 ? first : null;
}

function Defenders({
  scenario,
  numberedSources,
}: {
  scenario: FailureScenario;
  numberedSources: ReadonlyMap<string, NumberedSource>;
}) {
  return (
    <div className="min-w-0">
      <ul className="divide-y divide-border/40">
        {scenario.defenders.map((defender) => {
          const { icon: Icon, tone } = VERDICT_PRESENTATION[defender.verdict];
          const citations = resolveCitations(defender.sourceIds, numberedSources);
          return (
            <li key={defender.name} className="grid grid-cols-[1rem_minmax(0,1fr)_auto] gap-x-2.5 gap-y-0.5 py-2.5">
              <Icon aria-hidden="true" className={cn("mt-0.5 h-4 w-4", tone)} />
              <span className="text-sm font-medium text-foreground">{defender.name}</span>
              <span className={cn("whitespace-nowrap pt-px text-xs font-semibold", tone)}>
                {DEFENDER_VERDICT_LABEL[defender.verdict]}
              </span>
              <p className="col-span-2 col-start-2 text-[13px] leading-snug text-muted-foreground text-pretty">
                {defender.why}{" "}
                <span className="inline-flex translate-y-px items-center gap-1.5 align-baseline">
                  <EvidenceGlyph evidence={defender.evidence} />
                  <span className="sr-only">Evidence: {EVIDENCE_LABEL[defender.evidence]}</span>
                </span>{" "}
                <CitationLinks sources={citations} bare />
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Falsifiers({ scenario }: { scenario: FailureScenario }) {
  return (
    <div className="min-w-0">
      <p className="text-xs leading-relaxed text-muted-foreground text-pretty">
        Re-tested at every review; if any condition is met, the scenario comes off the page.
      </p>
      <ul className="divide-y divide-border/40">
        {scenario.falsifiers.map((falsifier) => {
          const { icon: Icon, tone } = FALSIFIER_PRESENTATION[falsifier.status];
          return (
            <li key={falsifier.condition} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2.5 gap-y-0.5 py-2.5">
              <Icon aria-hidden="true" className={cn("mt-0.5 h-4 w-4", tone)} />
              <p className="text-[13px] leading-snug text-foreground/90 text-pretty">{falsifier.condition}</p>
              <p className="col-start-2 flex flex-wrap items-baseline gap-x-1.5 text-[11px] text-muted-foreground">
                <span className={cn("font-medium", tone)}>{FALSIFIER_STATUS_LABEL[falsifier.status]}</span>
                {falsifier.checkedAtBlock != null ? (
                  <span>
                    · block <span className="pharos-numeric">{formatBlock(falsifier.checkedAtBlock)}</span>
                  </span>
                ) : null}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Exposure({ scenario }: { scenario: FailureScenario }) {
  if (scenario.exposure.length === 0) return null;
  return (
    <div className="min-w-0">
      <dl className="divide-y divide-border/40">
        {scenario.exposure.map((item) => (
          <div
            key={item.label}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 py-2.5 @2xl/evidence:grid-cols-[11rem_minmax(0,1fr)_auto]"
          >
            <dt className="text-sm font-medium text-foreground">{item.label}</dt>
            <dd className="col-span-2 row-start-2 text-[13px] leading-snug text-muted-foreground text-pretty @2xl/evidence:col-span-1 @2xl/evidence:col-start-2 @2xl/evidence:row-start-1">
              {item.detail}
            </dd>
            <dd className="col-start-2 row-start-1 @2xl/evidence:col-start-3">
              <EvidenceMarker evidence={item.evidence} className="text-[11px]" />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ReviewStamp({ selection }: { selection: FailureScenarioSelection }) {
  const { review, evidencePin } = selection.scenario;
  if (review.status === "approved") {
    return (
      <>
        Approved by {review.reviewedBy} on{" "}
        <span className="pharos-numeric whitespace-nowrap">{review.reviewedAt.slice(0, 10)}</span> · state at block{" "}
        <span className="pharos-numeric">{formatBlock(evidencePin.block)}</span>
      </>
    );
  }
  return (
    <>
      <span className={cn("font-medium", SEVERITY_TONE_CLASS.watch.text)}>Draft, not approved</span> · state at block{" "}
      <span className="pharos-numeric">{formatBlock(evidencePin.block)}</span>
    </>
  );
}

/** Opens the step a route-map node points at, then moves focus to its summary. */
function openStep(event: MouseEvent<HTMLAnchorElement>, stageId: string) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  const id = stepAnchorId(FAILURE_SCENARIO_MODULE_ID, stageId);
  window.history.pushState(null, "", `#${id}`);
  const target = revealAnchorId(id);
  target?.scrollIntoView({ block: "start" });
  target?.querySelector("summary")?.focus({ preventScroll: true });
}

/**
 * "How does X break?": one curated, maintainer-approved hypothetical failure
 * path in two layers. At a glance: the thesis and premise, the key figures,
 * the route map (the fork drawn as parallel routes, an open lock on every hop
 * that lacks a defense) and the to-scale clock. Then the step-by-step detail,
 * one disclosure per step, and the compact defenders, falsifiers and exposure.
 * It narrates a path the Safety Score already weighs; it never moves a grade.
 * Static by design: no entrance or scroll motion.
 */
export function FailureScenarioModule({ selection }: { selection: FailureScenarioSelection }) {
  const { scenario, isDraft } = selection;
  const numberedSources = useMemo(() => numberSources(scenario.sources), [scenario.sources]);
  const route = useMemo(() => buildScenarioRoute(scenario), [scenario]);
  const clock = useMemo(() => buildScenarioClock(scenario, route), [scenario, route]);
  const reviewedAt = scenario.review.status === "approved" ? scenario.review.reviewedAt : undefined;
  const sharedLabel = "Shared path";
  const draftNote = scenario.review.status === "draft" ? scenario.review.note : undefined;
  const summaryDraftNote = draftNote && findSummaryBudgetViolations(
    `Draft, not approved: development preview only. ${draftNote}`, SUMMARY_PROSE_MAX_WORDS,
  ).length === 0 ? draftNote : undefined;
  const premise = summaryPremise(scenario.premise);
  // The fold carries only what the summary did not already show.
  const foldPremise = premise ? scenario.premise.slice(premise.length).trim() : scenario.premise;
  const lockCount = route.steps.filter((step) => step.stage.missingDefense).length;

  // A step hash typed or pasted while the page is open opens that step; the
  // cold-load hash is aligned by the detail page itself.
  useEffect(() => {
    const onHashChange = () => {
      let id: string;
      try {
        id = decodeURIComponent(window.location.hash.slice(1));
      } catch {
        return;
      }
      if (!id.startsWith(`${FAILURE_SCENARIO_MODULE_ID}-`)) return;
      revealAnchorId(id)?.scrollIntoView({ block: "start" });
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return (
    <EvidenceModule
      id={FAILURE_SCENARIO_MODULE_ID}
      title={scenario.title}
      variant="module"
      headingLevel="h3"
      className={isDraft ? "border-dashed border-amber-500/60 dark:border-amber-400/50" : undefined}
      headerRight={
        <>
          <Badge variant="outline" className={NEUTRAL_CHIP_CLASS}>
            Not part of the Safety Score
          </Badge>
          <Badge variant="outline" className={NEUTRAL_CHIP_CLASS}>
            <FlaskConical aria-hidden="true" />
            Hypothetical scenario
          </Badge>
          {isDraft ? (
            <Badge variant="outline" className={cn(CHIP_CLASS, SEVERITY_TONE_CLASS.watch.pill)}>
              <FilePen aria-hidden="true" />
              Draft — not approved
            </Badge>
          ) : reviewedAt ? (
            <Badge variant="outline" className={NEUTRAL_CHIP_CLASS}>
              Reviewed <span className="pharos-numeric">{reviewedAt.slice(0, 10)}</span>
            </Badge>
          ) : null}
        </>
      }
      footer={
        <EvidenceFooter
          sources={scenario.sources.map((source) => ({ label: source.label, url: source.url }))}
          numberedSources
          foldId={`${FAILURE_SCENARIO_MODULE_ID}-sources`}
          trailing={<ReviewStamp selection={selection} />}
        >
          <span>Hypothetical premise · mechanics verified on-chain · outcomes inferred</span>
        </EvidenceFooter>
      }
      verdict={scenario.thesis}
      folds={
        <>
          <ModuleDisclosure
            id={`${FAILURE_SCENARIO_MODULE_ID}-path`}
            label="Scenario path, step by step"
          >
            <div className="space-y-5 pt-2">
              {foldPremise ? (
                <p className="text-sm leading-relaxed text-foreground/85 text-pretty">{foldPremise}</p>
              ) : null}
              {isDraft && draftNote && !summaryDraftNote ? (
                <p className="text-sm leading-relaxed text-muted-foreground text-pretty">{draftNote}</p>
              ) : null}
              {clock ? (
                <section aria-labelledby={`${FAILURE_SCENARIO_MODULE_ID}-clock`} className="min-w-0 space-y-3">
                  <h4 id={`${FAILURE_SCENARIO_MODULE_ID}-clock`} className={SUBHEADING_CLASS}>
                    Scenario clock <span className="font-normal text-muted-foreground">· to scale</span>
                  </h4>
                  <ScenarioClock scenario={scenario} clock={clock} sharedLabel={sharedLabel} />
                </section>
              ) : null}
              {scenario.window && !clock?.window ? (
                <p className="text-sm leading-relaxed text-muted-foreground text-pretty">
                  <span className="font-medium text-foreground">{scenario.window.label} · {scenario.window.duration}</span>
                  {" "}{scenario.window.note}
                </p>
              ) : null}
              <ScenarioSteps
                route={route}
                numberedSources={numberedSources}
                anchorPrefix={FAILURE_SCENARIO_MODULE_ID}
                sharedLabel={sharedLabel}
                headingId={`${FAILURE_SCENARIO_MODULE_ID}-steps`}
              />
            </div>
          </ModuleDisclosure>
          <ModuleDisclosure
            id={`${FAILURE_SCENARIO_MODULE_ID}-defenders`}
            label="Who could stop it?"
            count={scenario.defenders.length}
          >
            <Defenders scenario={scenario} numberedSources={numberedSources} />
          </ModuleDisclosure>
          <ModuleDisclosure
            id={`${FAILURE_SCENARIO_MODULE_ID}-falsifiers`}
            label="What would invalidate this scenario?"
            count={scenario.falsifiers.length}
          >
            <Falsifiers scenario={scenario} />
          </ModuleDisclosure>
          {scenario.exposure.length > 0 ? (
            <ModuleDisclosure
              id={`${FAILURE_SCENARIO_MODULE_ID}-exposure`}
              label="Who holds the loss?"
              count={scenario.exposure.length}
            >
              <Exposure scenario={scenario} />
            </ModuleDisclosure>
          ) : null}
        </>
      }
    >
      {isDraft ? <DraftNotice note={summaryDraftNote} /> : null}
      {premise ? <p className="text-sm leading-relaxed text-muted-foreground text-pretty">{premise}</p> : null}
      <FactGrid
        aria-label="Key figures"
        items={scenario.keyFigures.map((figure) => ({
          key: `${figure.value}:${figure.label}`,
          label: figure.label,
          value: figure.value,
          valueStyle: "figure",
          valueClassName: "text-foreground text-base",
          title: EVIDENCE_LABEL[figure.evidence],
        }))}
      />
      <section aria-labelledby={`${FAILURE_SCENARIO_MODULE_ID}-route`} className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1.5">
          <h4 id={`${FAILURE_SCENARIO_MODULE_ID}-route`} className={SUBHEADING_CLASS}>
            Scenario path{" "}
            <span className="font-normal text-muted-foreground">
              · <span className="pharos-numeric">{route.length}</span> steps
              {route.lanes.length > 0 ? (
                <>
                  , <span className="pharos-numeric">{route.lanes.length}</span> alternative routes
                </>
              ) : null}
            </span>
          </h4>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <MissingDefenseMark size="sm" />
              <span>
                <span className="pharos-numeric">{lockCount}</span> missing{" "}
                {lockCount === 1 ? "defense" : "defenses"}
              </span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <StepNumber label="" hypothetical terminal={false} className="h-3.5 min-w-3.5" />
              Hypothetical
            </span>
            <span className="inline-flex items-center gap-1.5">
              <StepNumber label="" hypothetical={false} terminal className="h-3.5 min-w-3.5" />
              Outcome
            </span>
          </p>
        </div>
        <RouteMap route={route} anchorPrefix={FAILURE_SCENARIO_MODULE_ID} onOpenStep={openStep} sharedLabel={sharedLabel} />
      </section>
    </EvidenceModule>
  );
}
