"use client";

import { ChevronDown, PauseCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  COVERAGE_GAP_OWNER_SWATCH_CLASSES,
  SAFETY_SCORE_OPEN_EVIDENCE_BUCKET_LABELS,
} from "@shared/lib/classification";
import { formatDecimal } from "@shared/lib/format";
import {
  describeIssuerReview,
  type DataCoverageModel,
  type DataCoverageReasonGap,
} from "@/lib/safety-score-data-coverage";

/** Static swatch per gap owner, in the canonical owner order of the view model. */
const OWNER_SWATCHES: Record<string, string> = COVERAGE_GAP_OWNER_SWATCH_CLASSES;

/**
 * Compact labels for the collapsed rail below `lg`, where five full labels no
 * longer fit on one line. Desktop keeps the view model's full labels. Each one
 * names the limit's owner, so `method-unsupported` shortens to the method
 * rather than to "Unsupported", which would read as a claim about the asset.
 */
const OWNER_SHORT_LABELS: Record<string, string> = {
  "issuer-undisclosed": "Issuer",
  "integration-missing": "Pharos",
  "producer-failed": "Feed",
  "method-unsupported": "Method",
  "published-evidence-expired": "Pharos",
  unresearched: "Unresolved",
  "public-data-uncurated": "Curation",
  mixed: "Several",
};

function formatCount(value: number): string {
  return formatDecimal(value, 0, 3);
}

function formatHeldSince(heldSinceSec: number): string {
  const ageSec = Math.max(0, Math.floor(Date.now() / 1000 - heldSinceSec));
  if (ageSec < 3600) return `${Math.max(1, Math.floor(ageSec / 60))}m ago`;
  if (ageSec < 86_400) return `${Math.floor(ageSec / 3600)}h ago`;
  return `${Math.floor(ageSec / 86_400)}d ago`;
}

function Count({ value }: { value: number }) {
  return <span className="font-semibold text-foreground">{formatCount(value)}</span>;
}

/** "1 documentation gap" reads correctly; the published label stays the vocabulary. */
function bucketNoun(label: string, count: number): string {
  return count === 1 ? label.replace(/s$/, "") : label;
}

/**
 * Headline counts, read as one sentence rather than a tile row. The three
 * bucket numbers are server-computed from `openEvidence`; this component only
 * formats them, and says "unavailable" instead of inventing a zero when the
 * payload predates the block (R1).
 */
function StatsSentence({ model }: { model: DataCoverageModel }) {
  const evidence = model.openEvidence;
  const buckets = SAFETY_SCORE_OPEN_EVIDENCE_BUCKET_LABELS;
  return (
    <p className="text-sm leading-relaxed text-muted-foreground">
      <Count value={model.assetCount} /> {model.assetCount === 1 ? "asset is" : "assets are"} assessed through the evaluation of{" "}
      <Count value={model.inputsEvaluated} /> inputs.{" "}
      {evidence ? (
        <>
          <Count value={evidence.open} /> {bucketNoun(buckets.open, evidence.open).toLowerCase()} ·{" "}
          <Count value={evidence.issuer} /> {bucketNoun(buckets.issuer, evidence.issuer).toLowerCase()} ·{" "}
          <Count value={evidence.documentation} /> {bucketNoun(buckets.documentation, evidence.documentation).toLowerCase()}.
        </>
      ) : (
        "Open-question counts are unavailable for this publication."
      )}
    </p>
  );
}

function GapOwnerBar({ model }: { model: DataCoverageModel }) {
  return (
    <div
      className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-md bg-background/70"
      role="img"
      aria-label={`${SAFETY_SCORE_OPEN_EVIDENCE_BUCKET_LABELS.open} by owner`}
    >
      {model.gapOwners.map((owner, index) => (
        <span
          key={owner.responsibility}
          className={cn(
            OWNER_SWATCHES[owner.responsibility] ?? "bg-muted-foreground",
            index === 0 && "rounded-l-md",
            index === model.gapOwners.length - 1 && "rounded-r-md",
          )}
          style={{ flexGrow: owner.questions }}
          title={`${owner.label}: ${formatCount(owner.questions)}`}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}

/** Count-only legend for the collapsed rail. */
function GapOwnerLegend({ model }: { model: DataCoverageModel }) {
  return (
    <ul className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5">
      {model.gapOwners.map((owner) => (
        <li key={owner.responsibility} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn(
              "h-2 w-2 shrink-0 rounded-sm",
              OWNER_SWATCHES[owner.responsibility] ?? "bg-muted-foreground",
            )}
          />
          <span className="text-2xs text-muted-foreground lg:hidden">
            {OWNER_SHORT_LABELS[owner.responsibility] ?? owner.label}
          </span>
          <span className="hidden text-2xs text-muted-foreground lg:inline">{owner.label}</span>
          <span className="pharos-numeric text-2xs font-semibold tabular-nums text-foreground">
            {formatCount(owner.questions)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The same owners spelled out, shown once the rail is expanded. */
function GapOwnerDetail({ model }: { model: DataCoverageModel }) {
  return (
    <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
      {model.gapOwners.map((owner) => (
        <li key={owner.responsibility} className="flex min-w-0 items-baseline gap-2">
          <span
            aria-hidden="true"
            className={cn(
              "mt-1 h-2 w-2 shrink-0 rounded-sm",
              OWNER_SWATCHES[owner.responsibility] ?? "bg-muted-foreground",
            )}
          />
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-medium text-foreground">{owner.label}</span>
            <span className="block text-2xs leading-snug text-muted-foreground">{owner.detail}</span>
          </span>
          <span className="pharos-numeric shrink-0 text-sm font-semibold tabular-nums text-foreground">
            {formatCount(owner.questions)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Per-stat breakdowns, demoted out of the rail so the headline stays one line. */
function StatDetail({ model }: { model: DataCoverageModel }) {
  const evidence = model.openEvidence;
  const pipelineGaps = model.pipelineGapCount === 1 ? "1 unrated pipeline gap" : `${formatCount(model.pipelineGapCount)} unrated pipeline gaps`;
  const critical =
    model.criticalGapCount === 0
      ? "none block a rating outright"
      : model.criticalGapCount === 1
        ? "1 blocks a rating outright"
        : `${formatCount(model.criticalGapCount)} block a rating outright`;
  const rows = [
    {
      label: "Assets assessed",
      detail: `${formatCount(model.ratedCount)} rated (${formatCount(model.partialRatedCount)} partial) · ${formatCount(model.notRatedCount)} not rated · ${pipelineGaps}`,
    },
    {
      label: "Inputs evaluated",
      detail: model.inputsByPillar
        .map((pillar) => `${pillar.label.toLowerCase()} ${formatCount(pillar.count)}`)
        .join(" · "),
    },
    {
      label: "Evidence obligations",
      detail: evidence
        ? `${formatCount(evidence.obligations)} evidence obligations behind them · ${formatCount(evidence.documentationDatums)} of which documentation · ${critical}`
        : "Unavailable for this publication",
    },
  ];
  return (
    <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-3">
      {rows.map((row) => (
        <li key={row.label} className="min-w-0">
          <span className="block text-xs font-medium text-foreground">{row.label}</span>
          <span className="pharos-numeric block text-2xs leading-snug text-muted-foreground">
            {row.detail}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** One reason row, prefixed by the server-assigned bucket so the split stays visible. */
function ReasonRow({ row }: { row: DataCoverageReasonGap }) {
  const unit =
    row.count === 1 ? row.countUnit.slice(0, -1) : row.countUnit;
  return (
    <li className="flex items-baseline justify-between gap-3 border-b border-border/30 py-1.5 last:border-b-0">
      <span className="min-w-0 text-xs text-foreground/85">
        <span className="text-muted-foreground">
          {SAFETY_SCORE_OPEN_EVIDENCE_BUCKET_LABELS[row.bucket]}
        </span>
        {" · "}
        {row.label}
      </span>
      <span className="pharos-numeric shrink-0 text-2xs tabular-nums text-muted-foreground">
        {formatCount(row.count)} {unit}
      </span>
    </li>
  );
}

function HoldRow({ hold }: { hold: NonNullable<DataCoverageModel["hold"]> }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-state-warn bg-state-warn-solid/[0.08] px-3 py-2">
      <PauseCircle
        className="mt-0.5 h-4 w-4 shrink-0 text-state-warn"
        aria-hidden="true"
      />
      <p className="min-w-0 text-xs leading-relaxed text-state-warn-strong">
        Ratings are held at the last verified snapshot
        {hold.heldSinceSec !== null ? (
          <>
            {" "}since{" "}
            <time
              suppressHydrationWarning
              dateTime={new Date(hold.heldSinceSec * 1000).toISOString()}
              title={new Date(hold.heldSinceSec * 1000).toLocaleString()}
            >
              {formatHeldSince(hold.heldSinceSec)}
            </time>
          </>
        ) : null}
        .{hold.causes.length > 0 ? ` ${hold.causes.join(" ")}` : ""}
      </p>
    </div>
  );
}

/**
 * Reader-facing account of what the Safety Score has measured and what it is
 * still missing. Only the headline
 * counts and the gap attribution stay visible; the owner explanations, the
 * per-stat breakdowns and the reason-code inventory expand on demand.
 *
 * A publication hold is rare and consequential, so it takes over the headline
 * row when present and pushes the counts into the disclosure.
 */
export function SafetyScoreDataCoverage({ model }: { model: DataCoverageModel | null }) {
  if (!model) return null;

  const backingKnownPct =
    model.backingObservedCount === 0
      ? null
      : Math.round((model.backingKnownCount / model.backingObservedCount) * 100);
  const hasOwners = model.gapOwners.length > 0;

  const expanded = (
    <div className="space-y-4 pt-4">
      {hasOwners ? <GapOwnerDetail model={model} /> : null}
      {model.openEvidence && model.openEvidence.issuer > 0 ? (
        <p className="text-2xs leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">
            {SAFETY_SCORE_OPEN_EVIDENCE_BUCKET_LABELS.issuer}
          </span>
          {". "}
          {model.openEvidence.issuerReview
            ? describeIssuerReview(model.openEvidence.issuerReview)
            : "The issuer does not publish these data; no review date is recorded."}
        </p>
      ) : null}
      <StatDetail model={model} />
      {model.openEvidence === null ? (
        <p className="text-2xs leading-relaxed text-muted-foreground">
          Open-question counts are unavailable for this publication, not zero.
        </p>
      ) : null}
      {model.reasons.length > 0 ? (
        <ul>
          {model.reasons.map((reason) => (
            <ReasonRow key={`${reason.bucket}:${reason.code}`} row={reason} />
          ))}
        </ul>
      ) : null}
      {backingKnownPct !== null ? (
        <p className="text-2xs leading-relaxed text-muted-foreground">
          Reserve inputs are the one set with a published observation state:{" "}
          <span className="font-medium text-foreground">{backingKnownPct}%</span> of{" "}
          {formatCount(model.backingObservedCount)} are fully known. Exit and economic-control
          inputs are counted but do not publish that split, so the two totals above are separate
          counts rather than a single ratio.
        </p>
      ) : null}
    </div>
  );

  return (
    <div className="space-y-3">
      {model.hold ? <HoldRow hold={model.hold} /> : <StatsSentence model={model} />}

      {hasOwners ? <GapOwnerBar model={model} /> : null}

      {/*
        The legend sits inside the summary so the rail keeps its collapsed height
        to a single row and the whole row becomes the toggle target. Screen
        readers announce the counts before the toggle label, which is verbose but
        keeps the counts reachable without expanding.
      */}
      <details className="group">
        <summary className="pharos-focus-ring flex min-h-11 cursor-pointer list-none flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-sm md:min-h-0">
          {hasOwners ? <GapOwnerLegend model={model} /> : <span className="pharos-label">Score inputs</span>}
          <span className="flex shrink-0 items-center gap-1.5 text-2xs font-medium text-muted-foreground">
            {model.reasons.length > 0
              ? `Which inputs are missing (${formatCount(model.reasons.length)})`
              : "Coverage detail"}
            <ChevronDown
              className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </span>
        </summary>
        {expanded}
      </details>
    </div>
  );
}
