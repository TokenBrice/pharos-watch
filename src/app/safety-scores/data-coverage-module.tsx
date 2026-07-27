"use client";

import { ChevronDown, PauseCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { DataCoverageModel } from "./data-coverage-view-model";

/** Static swatch per gap owner, in the canonical owner order of the view model. */
const OWNER_SWATCHES: Record<string, string> = {
  "issuer-undisclosed": "bg-amber-500",
  "integration-missing": "bg-frost-blue",
  "producer-failed": "bg-rose-500",
  "method-unsupported": "bg-muted-foreground",
};

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function formatHeldSince(heldSinceSec: number): string {
  const ageSec = Math.max(0, Math.floor(Date.now() / 1000 - heldSinceSec));
  if (ageSec < 3600) return `${Math.max(1, Math.floor(ageSec / 60))}m ago`;
  if (ageSec < 86_400) return `${Math.floor(ageSec / 3600)}h ago`;
  return `${Math.floor(ageSec / 86_400)}d ago`;
}

function HeadlineStat({
  value,
  label,
  detail,
}: {
  value: string;
  label: string;
  detail: string;
}) {
  return (
    <div className="min-w-0">
      <p className="pharos-numeric text-2xl font-semibold leading-none tracking-tight text-foreground sm:text-[1.75rem]">
        {value}
      </p>
      <p className="mt-1.5 pharos-kicker">{label}</p>
      <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{detail}</p>
    </div>
  );
}

function GapOwnerBar({ model }: { model: DataCoverageModel }) {
  if (model.gapOwners.length === 0) return null;
  return (
    <div className="space-y-3">
      <p className="pharos-kicker">Why the data is missing</p>
      <div
        className="flex h-3 w-full gap-0.5 overflow-hidden rounded-md bg-background/70"
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
    </div>
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
    <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2.5">
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
 * still missing. Replaces the raw publication-hold notice on this page: the
 * hold folds in as one plain-English row of a much larger coverage picture.
 */
export function SafetyScoreDataCoverage({ model }: { model: DataCoverageModel | null }) {
  if (!model) return null;

  const backingKnownPct =
    model.backingObservedCount === 0
      ? null
      : Math.round((model.backingKnownCount / model.backingObservedCount) * 100);

  return (
    <Card className="pharos-card-shell overflow-hidden" data-safety-model="v9">
      <CardContent className="space-y-5 px-4 py-5 sm:px-6 sm:py-6">
        <h2 className="pharos-kicker">Score inputs</h2>

        <div className="grid gap-5 border-y border-border/40 py-4 sm:grid-cols-3">
          <HeadlineStat
            value={formatCount(model.assetCount)}
            label="assets scored"
            detail={`${formatCount(model.ratedCount)} rated · ${formatCount(model.notRatedCount)} not rated`}
          />
          <HeadlineStat
            value={formatCount(model.inputsEvaluated)}
            label="inputs evaluated"
            detail={model.inputsByPillar
              .map((pillar) => `${pillar.label.toLowerCase()} ${formatCount(pillar.count)}`)
              .join(" · ")}
          />
          <HeadlineStat
            value={formatCount(model.openGapCount)}
            label="open data points"
            detail={
              model.criticalGapCount > 0
                ? `${formatCount(model.criticalGapCount)} block a rating outright`
                : "None block a rating outright"
            }
          />
        </div>

        <GapOwnerBar model={model} />

        {model.gapTypes.length > 0 ? (
          <details className="group border-t border-border/40 pt-3">
            <summary className="pharos-focus-ring flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-sm md:min-h-0">
              <span className="pharos-kicker">
                Which inputs are missing ({formatCount(model.gapTypes.length)})
              </span>
              <ChevronDown
                className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
                aria-hidden="true"
              />
            </summary>
            <ul className="pt-2">
              {model.gapTypes.map((gap) => (
                <GapTypeRow key={gap.code} label={gap.label} assetCount={gap.assetCount} />
              ))}
            </ul>
            {backingKnownPct !== null ? (
              <p className="pt-3 text-[11px] leading-relaxed text-muted-foreground">
                Reserve inputs are the one set with a published observation state:{" "}
                <span className="font-medium text-foreground">{backingKnownPct}%</span> of{" "}
                {formatCount(model.backingObservedCount)} are fully known. Exit and economic-control
                inputs are counted but do not publish that split, so the two totals above are
                separate counts rather than a single ratio.
              </p>
            ) : null}
          </details>
        ) : null}

        {model.hold ? <HoldRow hold={model.hold} /> : null}
      </CardContent>
    </Card>
  );
}
