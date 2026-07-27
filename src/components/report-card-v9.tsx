"use client";

import Link from "next/link";
import { Award, FileCheck2, Link2, LockKeyhole, ShieldCheck } from "lucide-react";
import type { ReportCardsV9Response } from "@shared/types/report-cards-v9";
import type { SafetyScoreV9CurrentCard } from "@shared/types";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { SafetyGradeBadge } from "@/components/safety-grade-badge";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import {
  selectV9Card,
  resolveV9ConsumerResponse,
  type V9ConsumerIdentity,
  type V9ConsumerUnavailableReason,
} from "@/lib/safety-score-v9-consumers";
import { buildStablecoinUrl } from "@/lib/urls";

const PILLARS = [
  ["backing", "Backing quality"],
  ["exit", "Exit quality"],
  ["control", "Control quality"],
] as const;

const ACCESS_FIELDS = [
  ["transfer", "Transfer"],
  ["freezeExposure", "Freeze exposure"],
  ["primaryExit", "Primary exit"],
  ["governance", "Governance"],
] as const;

function isUnknownDisplayValue(value: string | null | undefined): boolean {
  return value?.trim().toLowerCase() === "unknown";
}

function formatV9MethodologyLabel(methodologyVersion: string): string {
  const match = methodologyVersion.trim().match(/\bv?(9(?:\.\d+)*)\b/i);
  return match ? `v${match[1]}` : "v9.0";
}

function formatEvidenceSummary(
  level: string,
  freshness: string,
  noun: "coverage" | "evidence",
): string {
  const summary = `${level} ${noun}`;
  return isUnknownDisplayValue(freshness) ? summary : `${summary} · ${freshness}`;
}

function unavailableMessage(reason: V9ConsumerUnavailableReason): string {
  switch (reason) {
    case "identity-mismatch":
      return "Safety data is unavailable because the publication identity changed.";
    case "card-unavailable":
      return "Safety data is unavailable for this asset.";
    default:
      return "Safety data is unavailable for this publication.";
  }
}

function V9Unavailable({ reason }: { reason: V9ConsumerUnavailableReason }) {
  return (
    <Card className="pharos-card-shell">
      <CardContent className="py-8" role="alert">
        <p className="text-sm font-medium text-foreground">{unavailableMessage(reason)}</p>
        <p className="mt-1 font-mono text-xs text-muted-foreground">{reason}</p>
      </CardContent>
    </Card>
  );
}

function PillarRows({ card }: { card: SafetyScoreV9CurrentCard }) {
  return (
    <div className="divide-y divide-border/40 border-y border-border/40">
      {PILLARS.map(([key, label]) => {
        const pillar = card.pillars[key];
        return (
          <div key={key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{label}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {formatEvidenceSummary(pillar.evidenceLevel, pillar.freshness, "evidence")}
              </p>
              {pillar.reasons.length > 0 ? (
                <ul className="mt-2 space-y-1 text-xs leading-relaxed text-muted-foreground">
                  {pillar.reasons.map((reason) => (
                    <li key={`${reason.code}-${reason.path ?? "root"}`}>{reason.message}</li>
                  ))}
                </ul>
              ) : null}
            </div>
            <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
              {pillar.score === null ? "NR" : `${pillar.score.toFixed(0)} / 100`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function AccessPosture({ card }: { card: SafetyScoreV9CurrentCard }) {
  const rows = ACCESS_FIELDS.flatMap(([key, label]) => {
    const value = card.accessPosture[key];
    return isUnknownDisplayValue(value) ? [] : [{ key, label, value }];
  });

  if (rows.length === 0) return null;

  return (
    <section aria-labelledby={`${card.id}-v9-access`}>
      <div className="mb-2 flex items-center gap-2">
        <LockKeyhole className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <h3 id={`${card.id}-v9-access`} className="text-sm font-semibold">Access posture</h3>
      </div>
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.key} className="flex items-baseline justify-between gap-3 border-b border-border/40 pb-2">
            <dt className="text-xs text-muted-foreground">{row.label}</dt>
            <dd className="text-right font-mono text-xs text-foreground">{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function DependencyRows({ card }: { card: SafetyScoreV9CurrentCard }) {
  const dependencies = [
    ...card.dependencies.serial.map((dependency) => ({
      id: dependency.upstreamAssetId,
      label: dependency.blocked ? "Serial · blocked" : "Serial",
      detail: dependency.score === null ? "score unavailable" : `${dependency.score.toFixed(0)} / 100`,
    })),
    ...card.dependencies.basket.map((dependency) => ({
      id: dependency.upstreamAssetId,
      label: dependency.boundedUnknown ? "Basket · bounded unknown" : "Basket",
      detail: `${(dependency.weight * 100).toFixed(0)}% weight`,
    })),
  ];

  if (dependencies.length === 0) {
    return <p className="text-sm text-muted-foreground">No material stablecoin dependencies.</p>;
  }

  return (
    <ul className="divide-y divide-border/40 border-y border-border/40">
      {dependencies.map((dependency) => {
        const meta = CLIENT_TRACKED_META_BY_ID.get(dependency.id);
        return (
          <li key={`${dependency.label}-${dependency.id}`} className="flex flex-wrap items-baseline justify-between gap-2 py-2.5">
            <Link
              href={buildStablecoinUrl(dependency.id)}
              className="pharos-focus-ring rounded-sm text-sm font-medium text-frost-blue hover:underline"
            >
              {meta?.symbol ?? dependency.id}
            </Link>
            <span className="font-mono text-xs text-muted-foreground">
              {dependency.label} · {dependency.detail}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function ScoreAdjustment({ card }: { card: SafetyScoreV9CurrentCard }) {
  const adjustment = card.scoreTrace.scoreAdjustments[0];
  if (adjustment === undefined) return null;
  return (
    <section aria-labelledby={`${card.id}-v9-score-adjustment`}>
      <div className="mb-2 flex items-center gap-2">
        <Award className="h-4 w-4 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
        <h3 id={`${card.id}-v9-score-adjustment`} className="text-sm font-semibold">
          {adjustment.label}
        </h3>
        <span className="font-mono text-sm font-semibold text-emerald-700 dark:text-emerald-400">
          +{adjustment.appliedPoints.toFixed(0)}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        Ordinary score {adjustment.publishedScoreBefore.toFixed(0)} to published score{" "}
        {adjustment.publishedScoreAfter.toFixed(0)}. The {adjustment.capRelief.kind} limit is
        relaxed from {adjustment.capRelief.fromLimit.toFixed(0)} to{" "}
        {adjustment.capRelief.toLimit.toFixed(0)} for this asset only.
      </p>
    </section>
  );
}

export interface ReportCardV9DetailProps {
  response: unknown;
  expectedIdentity: V9ConsumerIdentity;
  cardId: string;
}

export function ReportCardV9Detail({ response, expectedIdentity, cardId }: ReportCardV9DetailProps) {
  const resolved = resolveV9ConsumerResponse(response, expectedIdentity);
  if (resolved.status === "unavailable") return <V9Unavailable reason={resolved.reason} />;
  const selected = selectV9Card(response, expectedIdentity, cardId);
  if (selected.status === "unavailable") return <V9Unavailable reason={selected.reason} />;

  const card = selected.value;
  const identity = selected.identity;
  const bindingCap = card.bindingCap;

  return (
    <Card className="pharos-card-shell gap-0 overflow-hidden py-0" data-safety-model="v9">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 border-b border-border/40 px-4 py-5 sm:px-5">
        <DetailSectionTitle className="text-sm font-semibold tracking-normal text-muted-foreground">
          Safety Score
        </DetailSectionTitle>
        <span className="font-mono text-[11px] text-muted-foreground">
          {formatV9MethodologyLabel(identity.methodologyVersion)}
        </span>
      </CardHeader>
      <CardContent className="space-y-6 px-4 py-5 sm:px-5">
        {resolved.value.publicationHealth.status === "held" ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300" role="status">
            Ratings held at the last verified snapshot
            {resolved.value.publicationHealth.heldSinceSec
              ? ` since ${new Date(resolved.value.publicationHealth.heldSinceSec * 1000).toLocaleString()}`
              : ""}
            .
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <SafetyGradeBadge grade={card.grade} score={card.score} showScore size="lg" />
          <div className="min-w-0">
            <p className="text-sm text-muted-foreground">
              {card.grade === "NR" ? "Not rated" : "Three-pillar safety assessment"}
            </p>
            {card.weakestPillar ? (
              <p className="mt-0.5 text-xs text-muted-foreground">
                Weakest pillar: {card.weakestPillar.pillar} ({card.weakestPillar.score.toFixed(0)})
              </p>
            ) : null}
          </div>
        </div>

        <PillarRows card={card} />

        <ScoreAdjustment card={card} />

        {bindingCap ? (
          <section aria-labelledby={`${card.id}-v9-cap`}>
            <div className="mb-2 flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-amber-700 dark:text-amber-400" aria-hidden="true" />
              <h3 id={`${card.id}-v9-cap`} className="text-sm font-semibold">Binding cap</h3>
            </div>
            <p className="text-sm text-muted-foreground">
              {bindingCap.reason} Limit {bindingCap.limit.toFixed(0)} / 100 ({bindingCap.source}).
            </p>
          </section>
        ) : null}

        {(card.reasonCodes.length > 0 || card.nrReasons.length > 0) ? (
          <section aria-labelledby={`${card.id}-v9-reasons`}>
            <h3 id={`${card.id}-v9-reasons`} className="mb-2 text-sm font-semibold">Reasons</h3>
            <ul className="space-y-1 text-sm text-muted-foreground">
              {card.nrReasons.map((reason) => <li key={`${reason.code}-${reason.field ?? "root"}`}>{reason.message}</li>)}
              {card.reasonCodes.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
          </section>
        ) : null}

        <section aria-labelledby={`${card.id}-v9-evidence`}>
          <div className="mb-2 flex items-center gap-2">
            <FileCheck2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <h3 id={`${card.id}-v9-evidence`} className="text-sm font-semibold">Evidence</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            {formatEvidenceSummary(card.evidence.level, card.evidence.freshness, "coverage")}
          </p>
          {card.evidence.reasons.map((reason) => (
            <p key={`${reason.code}-${reason.path ?? "root"}`} className="mt-1 text-xs text-muted-foreground">
              {reason.message}
            </p>
          ))}
        </section>

        <AccessPosture card={card} />

        <section aria-labelledby={`${card.id}-v9-dependencies`}>
          <div className="mb-2 flex items-center gap-2">
            <Link2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <h3 id={`${card.id}-v9-dependencies`} className="text-sm font-semibold">Dependencies</h3>
          </div>
          <DependencyRows card={card} />
        </section>
      </CardContent>
    </Card>
  );
}

export function ReportCardsV9ShadowRenderer({
  response,
  expectedIdentity,
}: {
  response: ReportCardsV9Response;
  expectedIdentity: V9ConsumerIdentity;
}) {
  const resolved = selectV9Card(response, expectedIdentity, response.cards[0]?.id ?? "");
  if (resolved.status === "unavailable") return <V9Unavailable reason={resolved.reason} />;
  return (
    <div className="grid gap-5" data-safety-model="v9">
      {response.cards.map((card) => (
        <ReportCardV9Detail
          key={card.id}
          response={response}
          expectedIdentity={expectedIdentity}
          cardId={card.id}
        />
      ))}
    </div>
  );
}
