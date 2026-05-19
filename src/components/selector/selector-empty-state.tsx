"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { SelectorProfile } from "@shared/lib/selector";

// TODO(integration): engine should optionally emit a `closestSurvivors` list
// (top-3 near-misses) and `relaxableConstraints` (which input to suggest
// loosening). The frontend renders whatever is provided; the fallback panel
// still works without these fields.
export interface SelectorClosestSurvivor {
  id: string;
  symbol: string;
  failingDimension: string;
  liveReading: string;
}

export interface SelectorRelaxableConstraint {
  key: "depegTolerance" | "venue" | "exitSpeed";
  label: string;
  description: string;
}

interface SelectorEmptyStateProps {
  profile: SelectorProfile;
  closestSurvivors: readonly SelectorClosestSurvivor[];
  relaxableConstraints: readonly SelectorRelaxableConstraint[];
  onRelax: (key: SelectorRelaxableConstraint["key"]) => void;
  screenerHandoffHref: string;
}

const PROFILE_LABEL: Record<SelectorProfile, string> = {
  treasury: "Treasury",
  yield: "Yield",
  trading: "Active Trading",
};

export function SelectorEmptyState({
  profile,
  closestSurvivors,
  relaxableConstraints,
  onRelax,
  screenerHandoffHref,
}: SelectorEmptyStateProps) {
  return (
    <section
      aria-labelledby="selector-empty-state"
      className="pharos-empty-note space-y-4 rounded-2xl border border-dashed border-border/55 bg-card/40 p-4 sm:p-5"
    >
      <div className="space-y-2">
        <h2 id="selector-empty-state" className="text-base font-semibold tracking-tight text-foreground sm:text-lg">
          No tracked stablecoin currently passes all exclusion filters for {PROFILE_LABEL[profile]}.
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          This is a real outcome, not a failure of the form. Three ways forward:
        </p>
      </div>

      {closestSurvivors.length > 0 ? (
        <div className="space-y-1.5">
          <p className="pharos-kicker">Closest survivors fail on:</p>
          <ul className="space-y-1 text-sm leading-relaxed">
            {closestSurvivors.map((survivor) => (
              <li key={survivor.id} className="text-foreground">
                <span className="font-semibold">{survivor.symbol}</span>
                <span className="text-muted-foreground">
                  {" "}— {survivor.failingDimension}: {survivor.liveReading}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {relaxableConstraints.length > 0 ? (
        <div className="space-y-2">
          <p className="pharos-kicker">Relax a constraint</p>
          <div className="flex flex-wrap gap-2">
            {relaxableConstraints.map((constraint) => (
              <button
                key={constraint.key}
                type="button"
                onClick={() => onRelax(constraint.key)}
                className="pharos-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-full border border-border/65 bg-background/60 px-3.5 text-sm font-medium text-foreground hover:bg-background/85 sm:min-h-9"
              >
                {constraint.label}
                <span className="text-xs text-muted-foreground">({constraint.description})</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <p className="pharos-kicker">Or refine in the Screener</p>
        <Link
          href={screenerHandoffHref}
          className="pharos-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-full border border-border/65 bg-background/60 px-3.5 text-sm font-medium text-foreground hover:bg-background/85 sm:min-h-9"
        >
          Open the Screener with these filters
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Or accept the answer — the dataset may genuinely not contain a fit for these inputs.
      </p>
    </section>
  );
}
