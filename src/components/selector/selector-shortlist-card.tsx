"use client";

import Link from "next/link";
import { ArrowUpRight, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { SafetyGradeBadge } from "@/components/safety-grade-badge";
import { cn } from "@/lib/utils";
import type {
  SelectorInput,
  SelectorProfile,
  SelectorRecommendation,
} from "@shared/lib/selector";
import { PEG_METADATA } from "@shared/lib/classification";

interface SelectorShortlistCardProps {
  rank: 1 | 2 | 3;
  recommendation: SelectorRecommendation;
  profile: SelectorProfile;
  pegCurrency: SelectorInput["pegCurrency"];
  isMobile: boolean;
  /** Logo URL keyed by coin id. Optional. */
  logoUrl?: string;
}

const PROFILE_LABEL: Record<SelectorProfile, string> = {
  treasury: "Treasury",
  yield: "Yield",
  trading: "Active Trading",
};

/** Discrete staleness label used on mobile (R2 Mobile concern #4). */
function discreteStalenessLabel(seconds: number): string {
  if (seconds <= 60) return "Fresh";
  if (seconds <= 120) return "1m";
  if (seconds <= 360) return "5m";
  return "Stale";
}

function precisStaleness(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h`;
}

interface TextChip {
  text: string;
  ariaLabel?: string;
  tone?: "default" | "watch";
}

function buildEvidenceChips(
  rec: SelectorRecommendation,
  isMobile: boolean,
): TextChip[] {
  const chips: TextChip[] = [];

  switch (rec.profile) {
    case "treasury": {
      const safety = rec.safetyGrade;
      if (safety) {
        chips.push({ text: `Safety ${safety}`, ariaLabel: `Safety grade ${safety}` });
      }
      const resilience = rec.components.find((c) => c.key === "resilience");
      if (resilience?.rawValue != null) {
        chips.push({
          text: `Resilience ${Math.round(resilience.rawValue)}`,
          ariaLabel: `Resilience score ${Math.round(resilience.rawValue)} of 100`,
        });
      }
      const dependency = rec.components.find((c) => c.key === "dependencyRisk");
      if (dependency?.rawValue != null) {
        chips.push({
          text: `Dependency Risk ${Math.round(dependency.rawValue)}`,
          ariaLabel: `Dependency risk score ${Math.round(dependency.rawValue)} of 100`,
        });
      }
      break;
    }
    case "yield": {
      const pys = rec.components.find((c) => c.key === "pharosYieldScore");
      if (pys?.rawValue != null) {
        chips.push({
          text: `PYS ${Math.round(pys.rawValue)}`,
          ariaLabel: `Pharos Yield Score ${Math.round(pys.rawValue)} of 100`,
        });
      }
      if (rec.recommendedSource) {
        chips.push({
          text: `APY ${rec.recommendedSource.apy30d.toFixed(1)}%`,
          ariaLabel: `Trailing 30-day APY ${rec.recommendedSource.apy30d.toFixed(1)} percent`,
        });
      }
      const safety = rec.safetyGrade;
      if (safety) {
        chips.push({ text: `Safety ${safety}`, ariaLabel: `Safety grade ${safety}` });
      }
      break;
    }
    case "trading": {
      const peg = rec.components.find((c) => c.key === "pegScoreNow");
      const liquidity = rec.components.find((c) => c.key === "liquidity");
      const dews = rec.components.find((c) => c.key === "dewsInverted");

      // Trading: per-input staleness chip replaces one evidence chip when triggered.
      // We surface PegScore + Liquidity + Staleness as the 3-chip set.
      if (peg?.rawValue != null) {
        chips.push({
          text: `Peg ${Math.round(peg.rawValue)}`,
          ariaLabel: `Peg score ${Math.round(peg.rawValue)} of 100`,
        });
      }
      if (liquidity?.rawValue != null) {
        chips.push({
          text: `Liquidity ${Math.round(liquidity.rawValue)}`,
          ariaLabel: `Liquidity score ${Math.round(liquidity.rawValue)} of 100`,
        });
      }
      // Pick the worst staleness across the per-input map.
      const ages = Object.values(rec.perInputStaleness ?? {});
      if (ages.length > 0) {
        const worst = Math.max(...ages);
        chips.push({
          text: isMobile
            ? `Watch: ${discreteStalenessLabel(worst)}`
            : `Watch: ${precisStaleness(worst)} stale`,
          ariaLabel: `Data freshness watch: ${discreteStalenessLabel(worst).toLowerCase()}`,
          tone: "watch",
        });
      } else if (dews?.rawValue != null) {
        chips.push({
          text: `DEWS ${Math.round(dews.rawValue)}`,
          ariaLabel: `DEWS stress score ${Math.round(dews.rawValue)} of 100. Lower is better.`,
        });
      }
      break;
    }
  }

  return chips.slice(0, 3);
}

export function SelectorShortlistCard(props: SelectorShortlistCardProps) {
  const { rank, recommendation: rec, profile, pegCurrency, isMobile, logoUrl } = props;
  const chips = buildEvidenceChips(rec, isMobile);
  const pegLabel = PEG_METADATA[pegCurrency]?.filterLabel ?? pegCurrency;

  const detailHref = `/stablecoin/${rec.id}/`;
  const profileLabel = PROFILE_LABEL[profile];
  const headlineId = `selector-shortlist-${rec.id}`;

  return (
    <li className="pharos-card-shell pharos-interactive-card relative overflow-hidden rounded-2xl border border-border/60 bg-card/60 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span aria-hidden="true" className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-border/70 bg-background/65 font-mono font-semibold text-foreground">
            {rank}
          </span>
          <span className="pharos-kicker">
            {profileLabel} profile result
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Badge variant="outline" className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            {pegLabel} peg
          </Badge>
          <Badge variant="outline" className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground" aria-label="Filter output, not advice">
            Filter output
          </Badge>
        </div>
      </div>

      <div className="flex items-start gap-3">
        {logoUrl ? (
          <img
            src={logoUrl}
            alt=""
            className="mt-0.5 h-9 w-9 shrink-0 rounded-full border border-border/55 bg-background/60 object-cover"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <span aria-hidden="true" className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border/55 bg-background/60 text-xs font-bold text-foreground">
            {rec.symbol.slice(0, 2)}
          </span>
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <h3 id={headlineId} className="text-base font-semibold tracking-tight text-foreground sm:text-lg">
            <span className="font-bold">{rec.symbol}</span>
            <span className="text-muted-foreground"> — {rec.name}</span>
          </h3>
          <div className="flex flex-wrap items-center gap-1.5">
            <SafetyGradeBadge grade={rec.safetyGrade} size="xs" />
          </div>
        </div>
      </div>

      <div className="mt-3 space-y-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Evidence checked
        </p>
        <ul className="flex flex-wrap gap-1.5" aria-label="Profile-conditioned evidence">
          {chips.map((chip) => (
            <li key={chip.text}>
              <Badge
                variant="outline"
                className={cn(
                  "text-[11px] font-medium",
                  chip.tone === "watch" && "border-amber-500/45 bg-amber-500/[0.07] text-amber-800 dark:text-amber-200",
                )}
                aria-label={chip.ariaLabel}
              >
                {chip.text}
              </Badge>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-3 space-y-2 text-sm leading-relaxed text-foreground">
        {/* TODO(integration): engine should attach pre-rendered prose to each
          * recommendation: `whyText` (from `whyKeys[]` + templates) and `watchText`
          * (from `lowestSubDimension` + templates). The fallback below renders the
          * raw keys + dimension so the card never ships an empty block. */}
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Why it ranked here
          </p>
          {"whyText" in rec && typeof rec.whyText === "string" && rec.whyText.length > 0 ? (
            <p>{rec.whyText}</p>
          ) : rec.whyKeys.length > 0 ? (
            <p>Profile-conditioned signals: {rec.whyKeys.slice(0, 2).join(", ")}.</p>
          ) : (
            <p>This entry survived the profile filters and ranked under the current weight set.</p>
          )}
        </div>
        {"watchText" in rec && typeof rec.watchText === "string" && rec.watchText.length > 0 ? (
          <div className="space-y-1 text-muted-foreground">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">
              What to watch
            </p>
            <p>
              {rec.watchText}{" "}
              <em className="text-xs">Historical readings; future behaviour may differ.</em>
            </p>
          </div>
        ) : (
          <div className="space-y-1 text-muted-foreground">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">
              What to watch
            </p>
            <p>
              {rec.lowestSubDimension.key} scores {Math.round(rec.lowestSubDimension.score)} under this profile.{" "}
              <em className="text-xs">Historical readings; future behaviour may differ.</em>
            </p>
          </div>
        )}
      </div>

      {rec.profile === "yield" && rec.recommendedSource ? (
        <p className="mt-3 flex flex-wrap items-baseline gap-1.5 text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">Yield rail:</span>
          <span>
            {rec.recommendedSource.protocol} on {rec.recommendedSource.chain} at{" "}
            {rec.recommendedSource.apy30d.toFixed(1)}%
            {rec.recommendedSource.pharosYieldScore != null
              ? ` (PYS ${rec.recommendedSource.pharosYieldScore})`
              : ""}
          </span>
        </p>
      ) : null}

      <div className="mt-4 flex items-center justify-between gap-2 pt-1 text-sm">
        <Link
          href={detailHref}
          className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm font-medium text-foreground underline underline-offset-4 hover:text-foreground"
          aria-label={`Open ${rec.name} detail page`}
          aria-labelledby={`${headlineId} open-detail-label-${rec.id}`}
        >
          <span id={`open-detail-label-${rec.id}`}>Open detail</span>
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
        {rec.confidence != null && rec.confidence < 60 ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/[0.07] px-2 py-0.5 text-xs font-medium text-amber-800 dark:text-amber-200">
            <Clock className="h-3 w-3" aria-hidden="true" />
            Lower confidence — limited data
          </span>
        ) : rec.confidence != null && rec.confidence < 80 ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-border/55 bg-background/65 px-2 py-0.5 text-xs text-muted-foreground">
            Limited data
          </span>
        ) : null}
      </div>
    </li>
  );
}
