"use client";

import { useId, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  Award,
  ChevronDown,
  FileCheck2,
  History,
  Link2,
  LockKeyhole,
  ShieldCheck,
  Table2,
} from "lucide-react";
import type { SafetyScoreV9CurrentCard } from "@shared/types";
import type { ReportCardsV9Response, V9PublicationHealth } from "@shared/types/report-cards-v9";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { scoreToGrade } from "@shared/lib/report-cards";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { FreshnessIndicator } from "@/components/status/freshness-indicator";
import { MethodologyHint } from "@/components/methodology-hint";
import { ShowYourWorkPanel } from "@/components/show-your-work-panel";
import { ShowYourWorkToggle } from "@/components/show-your-work-toggle";
import { METHODOLOGY_CONTEXT } from "@/lib/methodology-context";
import { getSafetyGradeMetadata } from "@/lib/report-card-ui";
import {
  buildStablecoinSafetyScoreV9Presentation,
  humanizeSafetyScoreV9Value,
  type StablecoinSafetyScoreV9Presentation,
} from "@/lib/stablecoin-safety-score-v9-presentation";
import { buildStablecoinUrl } from "@/lib/urls";
import { cn } from "@/lib/utils";

const HEADER_ICON_BUTTON_CLASS =
  "pharos-focus-ring inline-flex !h-11 !min-h-11 !w-11 items-center justify-center rounded-md border border-border/60 bg-muted/50 text-muted-foreground transition-colors hover:border-border hover:bg-muted hover:text-foreground md:!h-5 md:!min-h-0 md:!w-5";

function HeaderActions({ updatedAtMs }: { updatedAtMs: number | null }) {
  const methodology = METHODOLOGY_CONTEXT.safetyScore;
  return (
    <div className="flex shrink-0 items-center gap-2">
      {updatedAtMs !== null ? (
        <FreshnessIndicator
          compact
          updatedAtMs={updatedAtMs}
          staleAfterMs={API_FRESHNESS_MAX_AGE_SEC.reportCards * 1000}
          labelPrefix="Updated"
        />
      ) : null}
      {updatedAtMs !== null ? <span className="text-muted-foreground/50" aria-hidden="true">·</span> : null}
      <MethodologyHint topic="safetyScore" buttonClassName={HEADER_ICON_BUTTON_CLASS} />
      {methodology.changelogPath ? (
        <Link
          href={methodology.changelogPath}
          aria-label="Safety Score version history"
          className={HEADER_ICON_BUTTON_CLASS}
        >
          <History className="h-3 w-3" aria-hidden="true" />
        </Link>
      ) : null}
      <ShowYourWorkToggle className={HEADER_ICON_BUTTON_CLASS}>
        <Table2 className="h-3 w-3" aria-hidden="true" />
        <span className="sr-only">Show inputs</span>
      </ShowYourWorkToggle>
    </div>
  );
}

function formatRelativeTime(timestampMs: number): string {
  const ageSec = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  if (ageSec < 60) return "less than a minute ago";
  const ageMin = Math.floor(ageSec / 60);
  if (ageMin < 60) return `${ageMin}m ago`;
  const ageHours = Math.floor(ageMin / 60);
  if (ageHours < 24) return `${ageHours}h ago`;
  return `${Math.floor(ageHours / 24)}d ago`;
}

function HeldPublicationNotice({ health }: { health: V9PublicationHealth }) {
  if (health.status !== "held") return null;
  const heldSinceMs = health.heldSinceSec === null ? null : health.heldSinceSec * 1000;
  return (
    <div
      className="mx-4 mt-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 sm:mx-5 dark:text-amber-300"
      role="status"
    >
      Ratings held at the last verified snapshot
      {heldSinceMs !== null ? (
        <>
          {" "}since{" "}
          <time
            suppressHydrationWarning
            dateTime={new Date(heldSinceMs).toISOString()}
            title={new Date(heldSinceMs).toLocaleString(undefined, { timeZoneName: "long" })}
          >
            {formatRelativeTime(heldSinceMs)}
          </time>
        </>
      ) : null}
      .
    </div>
  );
}

function PillarRow({
  cardId,
  pillar,
}: {
  cardId: string;
  pillar: StablecoinSafetyScoreV9Presentation["pillars"][number];
}) {
  const [open, setOpen] = useState(pillar.isWeakest);
  const detailsId = useId();
  const hasDetails = pillar.componentCount > 0 || pillar.reasons.length > 0;
  const scoreGrade = pillar.score === null ? "NR" : scoreToGrade(pillar.score);
  const gradeMetadata = getSafetyGradeMetadata(scoreGrade);
  return (
    <div className="py-2">
      <button
        type="button"
        onClick={() => hasDetails && setOpen((value) => !value)}
        className={cn(
          "pharos-focus-ring block min-h-12 w-full rounded-sm py-1.5 text-left",
          !hasDetails && "cursor-default",
        )}
        aria-expanded={hasDetails ? open : undefined}
        aria-controls={hasDetails ? detailsId : undefined}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-foreground">{pillar.label}</span>
            <span className="mt-0.5 block text-[11px] text-muted-foreground">{pillar.evidenceSummary}</span>
          </span>
          <span className="whitespace-nowrap font-mono text-sm font-semibold tabular-nums text-foreground">
            {pillar.score === null ? "NR" : `${pillar.score.toFixed(0)} / 100`}
          </span>
          <span
            className={cn(
              "inline-flex min-w-9 items-center justify-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold",
              gradeMetadata.pillClassName,
            )}
            title="Pillar score band"
          >
            {scoreGrade}
          </span>
          <ChevronDown
            className={cn(
              "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180",
              !hasDetails && "invisible",
            )}
            aria-hidden="true"
          />
        </span>
        <span className="mt-2 grid grid-cols-[6.75rem_minmax(0,1fr)_2.25rem] items-center gap-2.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
            Pillar score
          </span>
          <span className="h-2.5 overflow-hidden rounded-[3px] border border-neutral-300 bg-neutral-200 dark:border-[#2a2a2d] dark:bg-[#1f1f21]">
            <span
              className={cn("block h-full rounded-[2px]", pillar.score === null ? "bg-muted-foreground/25" : "bg-neutral-500 dark:bg-[#858585]")}
              style={{ width: `${pillar.score ?? 0}%` }}
            />
          </span>
          <span className="text-right font-mono text-[10px] tabular-nums text-muted-foreground">
            {pillar.score === null ? "—" : pillar.score.toFixed(0)}
          </span>
        </span>
      </button>
      {hasDetails && open ? (
        <div
          id={detailsId}
          className="pb-2 pl-3 pr-1 pt-1 text-xs leading-relaxed text-muted-foreground"
          data-pillar={cardId}
        >
          {pillar.componentCount > 0 ? (
            <>
              <div className="flex items-center justify-between gap-3 font-mono text-[10px] uppercase tracking-[0.1em]">
                <span>Scored inputs</span>
                <span className="tabular-nums text-foreground">
                  {pillar.componentCount} / {pillar.componentCount}
                </span>
              </div>
              <div
                className="mt-2 flex h-1.5 gap-1"
                role="img"
                aria-label={`${pillar.componentCount} scored ${pillar.componentCount === 1 ? "input" : "inputs"}`}
              >
                {pillar.components.map((component) => (
                  <span
                    key={component.key}
                    className="min-w-1 flex-1 rounded-[2px] bg-neutral-500 dark:bg-[#858585]"
                  />
                ))}
              </div>
              <ul className="mt-2 grid gap-x-4 sm:grid-cols-2">
                {pillar.components.map((component) => (
                  <li
                    key={component.key}
                    className="flex min-w-0 items-center justify-between gap-2 border-b border-border/30 py-1.5 last:border-b-0"
                  >
                    <span className="flex min-w-0 items-center gap-2 text-foreground/85">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-[2px] bg-emerald-500" aria-hidden="true" />
                      <span className="truncate">{component.label}</span>
                    </span>
                    <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground">
                      {component.category}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {pillar.reasons.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {pillar.reasons.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ScoreAdjustment({ card }: { card: SafetyScoreV9CurrentCard }) {
  const adjustment = card.scoreTrace.scoreAdjustments[0];
  if (!adjustment) return null;
  return (
    <section className="border-b border-border/40 pb-3" aria-labelledby={`${card.id}-v9-adjustment`}>
      <div className="flex items-center gap-2">
        <Award className="h-4 w-4 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
        <h3 id={`${card.id}-v9-adjustment`} className="text-sm font-semibold">{adjustment.label}</h3>
        <span className="font-mono text-xs font-semibold text-emerald-700 dark:text-emerald-400">
          +{adjustment.appliedPoints.toFixed(0)}
        </span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        Published score rises from {adjustment.publishedScoreBefore.toFixed(0)} to{" "}
        {adjustment.publishedScoreAfter.toFixed(0)} under this asset-specific policy adjustment.
      </p>
    </section>
  );
}

function CapSection({ card }: { card: SafetyScoreV9CurrentCard }) {
  const cap = card.bindingCap;
  const wrapperLimit = card.scoreTrace.wrapperParentLimit;
  if (!cap && !wrapperLimit) return null;
  return (
    <section className="border-b border-border/40 pb-3" aria-labelledby={`${card.id}-v9-cap`}>
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-amber-700 dark:text-amber-400" aria-hidden="true" />
        <h3 id={`${card.id}-v9-cap`} className="text-sm font-semibold">
          {cap ? "Binding cap" : "Wrapper parent limit"}
        </h3>
      </div>
      {cap ? (
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {cap.reason} Limit {cap.limit.toFixed(0)} / 100.
        </p>
      ) : null}
      {wrapperLimit ? (
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Parent score {wrapperLimit.parentScore.toFixed(0)}; wrapper limit {wrapperLimit.limit.toFixed(0)} / 100
          {" "}using {humanizeSafetyScoreV9Value(wrapperLimit.treatment).toLowerCase()} treatment.
        </p>
      ) : null}
    </section>
  );
}

function EvidenceAndAccess({
  card,
  presentation,
}: {
  card: SafetyScoreV9CurrentCard;
  presentation: StablecoinSafetyScoreV9Presentation;
}) {
  return (
    <div className="grid gap-4 border-b border-border/40 pb-3 sm:grid-cols-2">
      <section aria-labelledby={`${card.id}-v9-evidence`}>
        <div className="flex items-center gap-2">
          <FileCheck2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <h3 id={`${card.id}-v9-evidence`} className="text-sm font-semibold">Evidence</h3>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{presentation.evidenceSummary}</p>
        {presentation.evidenceReasons.map((reason) => (
          <p key={reason} className="mt-1 text-xs leading-relaxed text-muted-foreground">{reason}</p>
        ))}
      </section>
      {presentation.accessRows.length > 0 ? (
        <section aria-labelledby={`${card.id}-v9-access`}>
          <div className="flex items-center gap-2">
            <LockKeyhole className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <h3 id={`${card.id}-v9-access`} className="text-sm font-semibold">Access posture</h3>
          </div>
          <dl className="mt-1 space-y-1">
            {presentation.accessRows.map((row) => (
              <div key={row.key} className="flex items-baseline justify-between gap-3 text-xs">
                <dt className="text-muted-foreground">{row.label}</dt>
                <dd className="text-right font-mono text-foreground">{row.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </div>
  );
}

function Dependencies({ card }: { card: SafetyScoreV9CurrentCard }) {
  const dependencies = [
    ...card.dependencies.serial.map((dependency) => ({
      id: dependency.upstreamAssetId,
      detail: dependency.blocked
        ? "Serial · blocked"
        : `Serial · ${dependency.score === null ? "score unavailable" : `${dependency.score.toFixed(0)} / 100`}`,
    })),
    ...card.dependencies.basket.map((dependency) => ({
      id: dependency.upstreamAssetId,
      detail: `${dependency.boundedUnknown ? "Basket · bounded unknown" : "Basket"} · ${(dependency.weight * 100).toFixed(0)}%`,
    })),
  ];
  return (
    <section aria-labelledby={`${card.id}-v9-dependencies`}>
      <div className="flex items-center gap-2">
        <Link2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <h3 id={`${card.id}-v9-dependencies`} className="text-sm font-semibold">Dependencies</h3>
      </div>
      {dependencies.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">No material stablecoin dependencies.</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {dependencies.map((dependency) => {
            const meta = CLIENT_TRACKED_META_BY_ID.get(dependency.id);
            return (
              <li key={`${dependency.id}-${dependency.detail}`} className="flex items-baseline justify-between gap-3 text-xs">
                <Link
                  href={buildStablecoinUrl(dependency.id)}
                  className="pharos-focus-ring rounded-sm font-medium text-frost-blue hover:underline"
                >
                  {meta?.symbol ?? dependency.id}
                </Link>
                <span className="text-right font-mono text-muted-foreground">{dependency.detail}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export interface StablecoinSafetyScoreV9CardProps {
  card: SafetyScoreV9CurrentCard;
  identity: ReportCardsV9Response["safetyScoreIdentity"];
  publicationHealth: V9PublicationHealth;
  updatedAtMs: number | null;
  stablecoinName?: string;
  rightColumn?: ReactNode;
}

export function StablecoinSafetyScoreV9Card({
  card,
  identity,
  publicationHealth,
  updatedAtMs,
  stablecoinName,
  rightColumn,
}: StablecoinSafetyScoreV9CardProps) {
  const presentation = buildStablecoinSafetyScoreV9Presentation(card);
  const hasRightColumn = rightColumn !== null && rightColumn !== undefined;
  const scoreColumn = (
    <div className="space-y-4">
      <div className={cn("pt-1", !hasRightColumn && "text-center")}>
        <div className={cn("flex items-baseline gap-2.5", !hasRightColumn && "justify-center")}>
          <span
            className={cn(
              "pharos-numeric text-4xl font-extrabold leading-none tracking-tight",
              getSafetyGradeMetadata(card.grade).pulse.accentClassName,
            )}
          >
            {card.grade}
          </span>
          {card.score !== null ? (
            <span className="pharos-numeric text-4xl font-extrabold leading-none tracking-tight text-foreground">
              {card.score.toFixed(0)} <span className="text-2xl font-bold text-muted-foreground">/ 100</span>
            </span>
          ) : (
            <span className="text-sm font-medium text-muted-foreground">Not rated</span>
          )}
        </div>
        {presentation.traceParts.length > 0 ? (
          <p className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {presentation.traceParts.map((part, index) => (
              <span key={part}>
                {index > 0 ? <span className="mr-2" aria-hidden="true">·</span> : null}
                {part}
              </span>
            ))}
          </p>
        ) : null}
      </div>

      <div className="divide-y divide-border/40 border-y border-border/40">
        {presentation.pillars.map((pillar) => (
          <PillarRow key={pillar.key} cardId={card.id} pillar={pillar} />
        ))}
      </div>

      <ScoreAdjustment card={card} />
      <CapSection card={card} />
      {presentation.primaryReasons.length > 0 ? (
        <section className="border-b border-border/40 pb-3" aria-labelledby={`${card.id}-v9-reasons`}>
          <h3 id={`${card.id}-v9-reasons`} className="text-sm font-semibold">Rating notes</h3>
          <ul className="mt-1 space-y-1 text-xs leading-relaxed text-muted-foreground">
            {presentation.primaryReasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
        </section>
      ) : null}
      <EvidenceAndAccess card={card} presentation={presentation} />
      <Dependencies card={card} />
    </div>
  );

  return (
    <Card className="pharos-card-shell gap-0 overflow-hidden py-0" data-safety-model="v9">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 border-b border-border/40 px-4 py-5 sm:px-5">
        <DetailSectionTitle className="text-sm font-semibold tracking-normal text-muted-foreground">
          Safety Score
        </DetailSectionTitle>
        <HeaderActions updatedAtMs={updatedAtMs} />
      </CardHeader>
      <CardContent className="px-0 py-0">
        <HeldPublicationNotice health={publicationHealth} />
        {hasRightColumn ? (
          <div className="grid min-h-[560px] lg:grid-cols-2">
            <div className="min-w-0 px-4 py-5 sm:px-5">{scoreColumn}</div>
            <div
              className="contents lg:flex lg:min-h-0 lg:min-w-0 lg:border-l lg:border-border/40 lg:px-5 lg:py-5"
              style={{ contain: "size" }}
            >
              <div className="min-w-0 border-t border-border/40 px-4 py-5 sm:px-5 lg:flex lg:min-h-0 lg:flex-1 lg:border-t-0 lg:p-0">
                {rightColumn}
              </div>
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-2xl px-4 py-5 sm:px-5">{scoreColumn}</div>
        )}
        <div className="mx-4 mb-5 sm:mx-5">
          <ShowYourWorkPanel
            kind="report-card-v9"
            card={card}
            methodologyVersion={identity.methodologyVersion}
            stablecoinId={card.id}
            stablecoinName={stablecoinName}
          />
        </div>
      </CardContent>
    </Card>
  );
}
