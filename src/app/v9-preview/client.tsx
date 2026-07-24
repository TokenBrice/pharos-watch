"use client";

import { useMemo, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { gradeRange, type ReportCardGradeRange } from "@shared/lib/report-cards";
import type { SafetyScoreV9CurrentCard } from "@shared/types";
import { SafetyGradeDistributionBar } from "@/components/safety-grade-distribution-bar";
import { SafetyGradeBadge } from "@/components/safety-grade-badge";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { TableBody, TableCaption, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useReportCardsV9Preview } from "@/hooks/api-hooks";
import { logosById } from "@/lib/logos";

function formatTimestamp(epochSeconds: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(epochSeconds * 1_000);
}

function formatScore(score: number | null): string {
  return score === null ? "NR" : score.toFixed(0);
}

function titleCase(value: string): string {
  return value
    .split("-")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function compareCards(left: SafetyScoreV9CurrentCard, right: SafetyScoreV9CurrentCard): number {
  if (left.score === null && right.score !== null) return 1;
  if (left.score !== null && right.score === null) return -1;
  if (left.score !== null && right.score !== null && left.score !== right.score) {
    return right.score - left.score;
  }
  return left.id.localeCompare(right.id);
}

function buildGradeCounts(cards: readonly SafetyScoreV9CurrentCard[]): Record<ReportCardGradeRange, number> {
  const counts: Record<ReportCardGradeRange, number> = { A: 0, B: 0, C: 0, D: 0, F: 0, NR: 0 };
  for (const card of cards) counts[gradeRange(card.grade)] += 1;
  return counts;
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="min-w-0 px-4 py-3 first:pl-0 last:pr-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate font-mono text-sm font-semibold text-foreground" title={String(value)}>
        {value}
      </dd>
    </div>
  );
}

function PillarValue({
  card,
  pillar,
}: {
  card: SafetyScoreV9CurrentCard;
  pillar: keyof SafetyScoreV9CurrentCard["pillars"];
}) {
  const value = card.pillars[pillar];
  return (
    <div>
      <span className="font-mono font-semibold text-foreground">{formatScore(value.score)}</span>
      <span className="ml-1 text-[11px] text-muted-foreground">{titleCase(value.evidenceLevel)}</span>
    </div>
  );
}

function PreviewTable({ cards }: { cards: readonly SafetyScoreV9CurrentCard[] }) {
  return (
    <TableFrame
      tableId="safety-score-v9-shadow-preview"
      stickyHeader
      tableClassName="min-w-[68rem] border-collapse text-left text-xs"
    >
      <TableCaption className="sr-only">Safety Score V9 shadow candidate ratings</TableCaption>
      <TableHeader className="bg-[var(--table-header-bg)] text-muted-foreground">
        <TableRow rowIntent="static">
          <TableHead scope="col" className="sticky left-0 z-10 bg-[var(--table-header-bg)] px-3 py-2.5">
            Asset
          </TableHead>
          <TableHead scope="col" className="px-3 py-2.5">
            V9 grade
          </TableHead>
          <TableHead scope="col" className="px-3 py-2.5">
            Backing
          </TableHead>
          <TableHead scope="col" className="px-3 py-2.5">
            Exit
          </TableHead>
          <TableHead scope="col" className="px-3 py-2.5">
            Control
          </TableHead>
          <TableHead scope="col" className="px-3 py-2.5">
            Weakest pillar
          </TableHead>
          <TableHead scope="col" className="px-3 py-2.5">
            Binding cap
          </TableHead>
          <TableHead scope="col" className="px-3 py-2.5">
            Evidence
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody className="divide-y divide-border/60">
        {cards.map((card) => {
          const meta = CLIENT_TRACKED_META_BY_ID.get(card.id);
          const name = meta?.name ?? card.id;
          return (
            <TableRow key={card.id} rowIntent="scan" className="align-middle hover:bg-[var(--table-row-hover)]">
              <TableHead scope="row" className="sticky left-0 z-[1] h-auto bg-background px-3 py-3 font-normal">
                <div className="flex min-w-[13rem] items-center gap-2.5">
                  <StablecoinLogo src={logosById[card.id]} name={name} size={28} />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-foreground" title={name}>
                      {meta?.symbol ?? card.id}
                    </div>
                    <div
                      className="max-w-[12rem] truncate text-[11px] text-muted-foreground"
                      title={`${name} · ${card.id}`}
                    >
                      {name}
                    </div>
                  </div>
                </div>
              </TableHead>
              <TableCell className="px-3 py-3">
                <div className="flex min-w-[10rem] flex-col items-start gap-1.5">
                  <SafetyGradeBadge
                    grade={card.grade}
                    score={card.score === null ? null : Math.round(card.score)}
                    showScore
                    size="xs"
                  />
                  {card.scoreTrace.scoreAdjustments.map((adjustment) => (
                    <span
                      key={adjustment.kind}
                      className="max-w-[11rem] text-[11px] leading-4 text-emerald-700 dark:text-emerald-400"
                    >
                      {adjustment.label} +{adjustment.appliedPoints.toFixed(0)}
                    </span>
                  ))}
                </div>
              </TableCell>
              <TableCell className="px-3 py-3">
                <PillarValue card={card} pillar="backing" />
              </TableCell>
              <TableCell className="px-3 py-3">
                <PillarValue card={card} pillar="exit" />
              </TableCell>
              <TableCell className="px-3 py-3">
                <PillarValue card={card} pillar="control" />
              </TableCell>
              <TableCell className="px-3 py-3">
                {card.weakestPillar ? (
                  <>
                    <div className="font-medium text-foreground">{titleCase(card.weakestPillar.pillar)}</div>
                    <div className="mt-0.5 font-mono text-muted-foreground">{card.weakestPillar.score.toFixed(0)}</div>
                  </>
                ) : (
                  <span className="text-muted-foreground">Unresolved</span>
                )}
              </TableCell>
              <TableCell className="max-w-[13rem] whitespace-normal px-3 py-3">
                {card.bindingCap ? (
                  <>
                    <div className="font-medium text-foreground">{titleCase(card.bindingCap.kind)}</div>
                    <div className="mt-0.5 text-muted-foreground">Limit {card.bindingCap.limit.toFixed(0)}</div>
                  </>
                ) : (
                  <span className="text-muted-foreground">None</span>
                )}
              </TableCell>
              <TableCell className="px-3 py-3">
                <div className="font-medium text-foreground">{titleCase(card.evidence.level)}</div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </TableFrame>
  );
}

export function SafetyScoreV9PreviewClient() {
  const { data, isLoading, isFetching, error, refetch } = useReportCardsV9Preview();
  const [search, setSearch] = useState("");
  const gradeCounts = useMemo(() => buildGradeCounts(data?.cards ?? []), [data?.cards]);
  const cards = useMemo(() => {
    const query = search.trim().toLowerCase();
    return [...(data?.cards ?? [])]
      .filter((card) => {
        if (!query) return true;
        const meta = CLIENT_TRACKED_META_BY_ID.get(card.id);
        return [card.id, meta?.name, meta?.symbol].some((value) => value?.toLowerCase().includes(query));
      })
      .sort(compareCards);
  }, [data?.cards, search]);

  if (isLoading) {
    return (
      <div className="space-y-3" role="status" aria-label="Loading V9 shadow ratings">
        <div className="h-20 animate-pulse rounded-md bg-muted/40" />
        <div className="h-[28rem] animate-pulse rounded-md bg-muted/40" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div
        className="pharos-empty-note flex flex-col items-start gap-3"
        role="alert"
        aria-busy={isFetching || undefined}
      >
        <div>
          <p className="font-medium text-foreground">V9 shadow ratings are temporarily unavailable.</p>
          <p className="mt-1 text-sm text-muted-foreground">The live V8 ratings are unaffected.</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={isFetching}
          onClick={() => void refetch()}
        >
          <RefreshCw
            className={`h-4 w-4 ${isFetching ? "animate-spin motion-reduce:animate-none" : ""}`}
            aria-hidden="true"
          />
          {isFetching ? "Retrying" : "Retry"}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <dl className="grid divide-y divide-border/60 border-y border-border/70 sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:grid-cols-4">
        <Metric label="Rated assets" value={data.completeness.ratedCount} />
        <Metric label="Not rated" value={data.completeness.notRatedCount} />
        <Metric label="Methodology" value={data.methodology.version} />
        <Metric label="Published" value={`${formatTimestamp(data.updatedAt)} UTC`} />
      </dl>

      <SafetyGradeDistributionBar gradeCounts={gradeCounts} totalCards={data.cards.length} totalLabel="assets" />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Candidate ratings</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {cards.length} of {data.cards.length} assets
          </p>
        </div>
        <label className="relative block w-full sm:w-72">
          <span className="sr-only">Search candidate ratings</span>
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search asset"
            className="pl-9"
          />
        </label>
      </div>

      {cards.length > 0 ? (
        <PreviewTable cards={cards} />
      ) : (
        <p className="pharos-empty-note text-sm text-muted-foreground">No candidate ratings match this search.</p>
      )}
    </div>
  );
}
