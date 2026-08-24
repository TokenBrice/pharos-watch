"use client";

import { ChevronDown, PauseCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDecimal } from "@shared/lib/format";
import type { DataCoverageModel } from "@/lib/safety-score-data-coverage";

/** Static swatch per gap owner, in the canonical owner order of the view model. */
const OWNER_SWATCHES: Record<string, string> = {
  "issuer-undisclosed": "bg-amber-500",
  "integration-missing": "bg-frost-blue",
  "producer-failed": "bg-rose-500",
  "method-unsupported": "bg-muted-foreground",
  "published-evidence-expired": "bg-sky-500",
};

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

/** Headline counts, read as one sentence rather than a tile row. */
function StatsSentence({ model }: { model: DataCoverageModel }) {
  return (
    <p className="text-sm leading-relaxed text-muted-foreground">
      <Count value={model.assetCount} /> {model.assetCount === 1 ? "asset is" : "assets are"} scored, thanks to the evaluation of{" "}
      <Count value={model.inputsEvaluated} /> inputs with <Count value={model.openGapCount} />{" "}
      remaining open data points.
    </p>
  );
}

function GapOwnerBar({ model }: { model: DataCoverageModel }) {
  return (
    <div
      className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-md bg-background/70"
      role="img"
      aria-label="Open data points by cause"
    >
      {model.gapOwners.map((owner, index) => (
        <span
          key={owner.responsibility}
          className={cn(
            OWNER_SWATCHES[owner.responsibility] ?? "bg-muted-foreground",
            index === 0 && "rounded-l-md",
            index === model.gapOwners.length - 1 && "rounded-r-md",
          )}
          style={{ flexGrow: owner.count }}
          title={`${owner.label}: ${formatCount(owner.count)}`}
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
          <span className="text-[11px] text-muted-foreground lg:hidden">
            {OWNER_SHORT_LABELS[owner.responsibility] ?? owner.label}
          </span>
          <span className="hidden text-[11px] text-muted-foreground lg:inline">{owner.label}</span>
          <span className="pharos-numeric text-[11px] font-semibold tabular-nums text-foreground">
            {formatCount(owner.count)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The same five owners spelled out, shown once the rail is expanded. */
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
            <span className="block text-[11px] leading-snug text-muted-foreground">{owner.detail}</span>
          </span>
          <span className="pharos-numeric shrink-0 text-sm font-semibold tabular-nums text-foreground">
            {formatCount(owner.count)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Per-stat breakdowns, demoted out of the rail so the headline stays one line. */
function StatDetail({ model }: { model: DataCoverageModel }) {
  const rows = [
    {
      label: "Assets scored",
      detail: `${formatCount(model.ratedCount)} rated · ${formatCount(model.notRatedCount)} not rated`,
    },
    {
      label: "Inputs evaluated",
      detail: model.inputsByPillar
        .map((pillar) => `${pillar.label.toLowerCase()} ${formatCount(pillar.count)}`)
        .join(" · "),
    },
    {
      label: "Open data points",
      detail:
        model.criticalGapCount > 0
          ? `${formatCount(model.criticalGapCount)} block a rating outright`
          : "None block a rating outright",
    },
  ];
  return (
    <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-3">
      {rows.map((row) => (
        <li key={row.label} className="min-w-0">
          <span className="block text-xs font-medium text-foreground">{row.label}</span>
          <span className="pharos-numeric block text-[11px] leading-snug text-muted-foreground">
            {row.detail}
          </span>
        </li>
      ))}
    </ul>
  );
}

function GapTypeRow({ label, assetCount }: { label: string; assetCount: number }) {
  return (
    <li className="flex items-baseline justify-between gap-3 border-b border-border/30 py-1.5 last:border-b-0">
      <span className="min-w-0 text-xs text-foreground/85">{label}</span>
      <span className="pharos-numeric shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {formatCount(assetCount)} {assetCount === 1 ? "asset" : "assets"}
      </span>
    </li>
  );
}

function HoldRow({ hold }: { hold: NonNullable<DataCoverageModel["hold"]> }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2">
      <PauseCircle
        className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400"
        aria-hidden="true"
      />
      <p className="min-w-0 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
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
      <StatDetail model={model} />
      {model.gapTypes.length > 0 ? (
        <ul>
          {model.gapTypes.map((gap) => (
            <GapTypeRow key={gap.code} label={gap.label} assetCount={gap.assetCount} />
          ))}
        </ul>
      ) : null}
      {backingKnownPct !== null ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
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
          {hasOwners ? <GapOwnerLegend model={model} /> : <span className="pharos-kicker">Score inputs</span>}
          <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            {model.gapTypes.length > 0
              ? `Which inputs are missing (${formatCount(model.gapTypes.length)})`
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
