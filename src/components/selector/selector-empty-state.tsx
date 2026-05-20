"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { SelectorInput, SelectorProfile } from "@shared/lib/selector";
import { PEG_METADATA } from "@shared/lib/classification";

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
  pegCurrency: SelectorInput["pegCurrency"];
  coverageSparse: boolean;
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
  pegCurrency,
  coverageSparse,
  closestSurvivors,
  relaxableConstraints,
  onRelax,
  screenerHandoffHref,
}: SelectorEmptyStateProps) {
  const pegLabel = PEG_METADATA[pegCurrency]?.filterLabel ?? pegCurrency;
  const heading = coverageSparse
    ? `Not enough eligible ${pegLabel} coverage currently passes live-data checks for ${PROFILE_LABEL[profile]}.`
    : `No tracked ${pegLabel} stablecoin currently passes all exclusion filters for ${PROFILE_LABEL[profile]}.`;

  return (
    <section
      aria-labelledby="selector-empty-state"
      className="pharos-empty-note space-y-4 rounded-2xl border border-dashed border-border/55 bg-card/40 p-4 sm:p-5"
    >
      <div className="space-y-2">
        <h2 id="selector-empty-state" className="text-base font-semibold tracking-tight text-foreground sm:text-lg">
          {heading}
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {coverageSparse
            ? `Pharos tracks this peg, but Safety, Peg/DEWS, liquidity, or yield signals are too thin for a shortlist under these answers.`
            : "This is a real outcome, not a failure of the form. Three ways forward:"}
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
                  {" "}— {readableFailingDimension(survivor.failingDimension)}: {survivor.liveReading}
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

function readableFailingDimension(value: string): string {
  const labels: Record<string, string> = {
    "below-supply-floor": "supply floor",
    "active-depeg": "active depeg",
    "safety-grade-floor": "safety grade",
    "safety-resilience-floor": "resilience",
    "safety-dependency-risk-floor": "dependency risk",
    "dews-ceiling": "DEWS stress",
    "depeg-event-count": "depeg history",
    "bluechip-d-or-f": "blue-chip alignment",
    "peg-stability-floor": "peg stability",
    "pys-null": "yield coverage",
    "apy-below-floor": "yield floor",
    "yield-warning-unstable": "yield stability",
    "yield-warning-thin-tvl": "yield depth",
    "high-venue-on-c-tier": "venue risk",
    "liquidity-floor": "liquidity",
    "liquidity-diversification-floor": "liquidity diversification",
    "effective-exit-floor": "effective exit",
    "supply-tvl-floor-1h": "one-hour exit depth",
    "lifecycle-non-active": "lifecycle",
    "peg-currency-mismatch": "peg currency",
    "yield-native-only-violation": "native yield",
    "decentralization-required-violation": "decentralization",
    "custody-onchain-only-violation": "custody model",
    "howey-uncertain": "regulatory uncertainty",
    "template-coverage-gap": "template coverage",
    "coverage-too-thin": "coverage",
  };
  return labels[value] ?? value.replace(/-/g, " ");
}
