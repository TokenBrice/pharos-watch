"use client";

import { CircleCheck, CircleDashed, ExternalLink, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { MethodologyCardActions, MethodologyLabel } from "@/components/methodology-hint";
import { ScoreBadgeWrapper } from "@/components/score-badge-wrapper";
import { ScoringBreakdownDisclosure } from "@/components/stablecoin-detail/scoring-breakdown-disclosure";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import {
  DETAIL_MODULE_BODY_CLASS,
  DETAIL_MODULE_HEADER_CLASS,
  DETAIL_MODULE_SHELL_CLASS,
  DETAIL_MODULE_TITLE_CLASS,
  SECTION_SCROLL_MT,
} from "@/components/stablecoin-detail/section-title-class";
import type {
  MintAuthorityDetailControlViewModel,
  MintAuthorityDetailScoreViewModel,
  MintAuthorityDetailViewModel,
  MintAuthorityPostureTone,
} from "@/lib/stablecoin-detail-mint-authority-view-model";
import type { MintAuthorityDecentralizationDragViewModel } from "@/lib/stablecoin-detail-view-model";
import { cn } from "@/lib/utils";

const POSTURE_DOT_CLASS: Record<MintAuthorityPostureTone, string> = {
  minimized: "bg-[var(--severity-healthy)]",
  neutral: "bg-[var(--text-tertiary)]",
  elevated: "bg-[var(--severity-mild)]",
};

function DetailBadge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn("border-border/60 bg-muted/30 text-[11px] font-medium text-muted-foreground", className)}
    >
      {children}
    </Badge>
  );
}

function ControlMeta({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</span>
      <span className="text-xs text-foreground">{value}</span>
    </span>
  );
}

function MintAuthorityControlRow({ control }: { control: MintAuthorityDetailControlViewModel }) {
  const locationClassName =
    "max-w-full rounded-md border border-border/60 bg-background/70 px-2 py-1 font-mono text-[11px] text-muted-foreground";
  // Setup only earns the meta slot when it adds detail beyond the authority type already shown in the subtitle.
  const setupValue = control.securitySetupLabel === control.authorityTypeLabel ? null : control.securitySetupLabel;

  return (
    <li className="px-3 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{control.label}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {control.roleLabel} / {control.authorityTypeLabel}
          </p>
        </div>
        {control.addressUrl ? (
          <a
            href={control.addressUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={control.fullLocationLabel}
            aria-label={`Open ${control.fullLocationLabel} in explorer`}
            className={cn(
              "pharos-focus-ring inline-flex min-w-0 items-center gap-1 break-all transition-colors hover:text-foreground sm:break-normal",
              locationClassName,
            )}
          >
            <span>{control.locationLabel}</span>
            <ExternalLink aria-hidden className="h-3 w-3 shrink-0" />
          </a>
        ) : (
          <span
            title={control.fullLocationLabel}
            className={cn("inline-flex break-all sm:break-normal", locationClassName)}
          >
            {control.locationLabel}
          </span>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
        <ControlMeta label="Mint" value={control.directMintAbilityLabel} />
        <ControlMeta label="Setup" value={setupValue} />
        <ControlMeta label="Custody" value={control.custodyLabel} />
        <ControlMeta label="Delay" value={control.timelockLabel} />
        <ControlMeta label="Safe modules/guard" value={control.modulesOrGuardsLabel} />
      </div>
      {control.capDescription ? <p className="mt-2 text-xs text-muted-foreground">{control.capDescription}</p> : null}
    </li>
  );
}

function MintAuthorityIncidentSources({
  sources,
}: {
  sources: MintAuthorityDetailViewModel["mintIncidents"][number]["sources"];
}) {
  if (sources.length === 0) return null;

  return (
    <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-1 text-[11px]">
      {sources.map((source) => (
        <a
          key={`${source.label}:${source.url}`}
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
          className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm underline underline-offset-2 transition-colors hover:text-red-900 dark:hover:text-red-100"
        >
          {source.label}
          <ExternalLink aria-hidden className="h-3 w-3" />
        </a>
      ))}
    </div>
  );
}

function MintAuthorityScoreBreakdown({ score }: { score: MintAuthorityDetailScoreViewModel }) {
  const controlSummary = [score.weakestControlLabel, score.weakestControlScoreLabel, score.weakestControlCustodyLabel]
    .filter(Boolean)
    .join(" / ");

  return (
    <ScoringBreakdownDisclosure>
      <div className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 xl:grid-cols-4">
        {score.components.map((component) => (
          <div key={component.key} className="rounded-lg border border-border/60 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-foreground">{component.label}</span>
              <span className="text-[10px] uppercase tracking-[0.12em]">{component.weightLabel}</span>
            </div>
            <p className={cn("mt-1 pharos-numeric text-sm", component.textClassName)}>{component.scoreLabel}</p>
          </div>
        ))}
      </div>
      <div className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
        <div className="rounded-lg border border-border/60 px-3 py-2">
          <span className="font-medium text-foreground">Raw score</span>{" "}
          <span className="pharos-numeric">{score.rawScoreLabel ?? "NR"}</span>
          {score.confidenceCapLabel ? <span className="ml-2">Confidence cap {score.confidenceCapLabel}</span> : null}
        </div>
        <div className="rounded-lg border border-border/60 px-3 py-2">
          <span className="font-medium text-foreground">Caps</span>{" "}
          {score.capsApplied.length > 0 ? score.capsApplied.join(", ") : "No caps applied"}
        </div>
        {controlSummary ? (
          <div className="rounded-lg border border-border/60 px-3 py-2 sm:col-span-2">
            <span className="font-medium text-foreground">Weakest mint-capable control</span> {controlSummary}
          </div>
        ) : null}
        {score.unresolvedReasonLabel ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-700 dark:text-amber-300 sm:col-span-2">
            Not rated: {score.unresolvedReasonLabel}
          </div>
        ) : null}
      </div>
    </ScoringBreakdownDisclosure>
  );
}

export function MintAuthoritySection({
  profile,
  decentralizationDrag,
}: {
  profile?: MintAuthorityDetailViewModel | null;
  decentralizationDrag?: MintAuthorityDecentralizationDragViewModel | null;
}) {
  if (!profile) return null;
  const isReviewed = profile.status === "reviewed";
  const score = profile.score;
  const scoreTriggerLabel = score
    ? `Mint Authority Score ${score.scoreLabel}, ${score.bandLabel}. Explain methodology.`
    : undefined;
  const unresolvedQuestions = profile.unresolvedQuestions ?? [];
  const hasVerificationGaps = !!profile.sourceFreeRationale || unresolvedQuestions.length > 0;

  return (
    <Card id="mint-authority" className={cn(DETAIL_MODULE_SHELL_CLASS, SECTION_SCROLL_MT)}>
      <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <DetailSectionTitle className={DETAIL_MODULE_TITLE_CLASS}>
            <MethodologyLabel topic="mintAuthorityScore">Mint Authority</MethodologyLabel>
          </DetailSectionTitle>
          {score ? (
            <ScoreBadgeWrapper topic="mintAuthorityScore" variant="tooltip-only" triggerAriaLabel={scoreTriggerLabel}>
              <Badge
                variant="outline"
                className={cn("px-2 py-0.5 pharos-numeric text-sm", score.badgeClassName)}
                title={score.detail}
              >
                {score.scoreLabel}
              </Badge>
            </ScoreBadgeWrapper>
          ) : (
            <Badge
              variant="outline"
              className="border-border/60 bg-muted/30 px-2 py-0.5 pharos-numeric text-sm text-muted-foreground"
              title="Mint Authority Score is not rated."
            >
              NR
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className={cn(DETAIL_MODULE_BODY_CLASS, "space-y-4")}>
        {!isReviewed ? (
          <>
            <div className="flex flex-wrap gap-1.5">
              <DetailBadge>{profile.reviewLabel}</DetailBadge>
              <DetailBadge>Mint Authority Score: NR</DetailBadge>
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">{profile.summary}</p>
            <MethodologyCardActions topic="mintAuthorityScore" />
          </>
        ) : (
          <>
            {score ? (
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
                <span className={cn("text-sm font-medium", score.textClassName)}>{score.bandLabel}</span>
                {decentralizationDrag ? (
                  <a
                    href="#report-card"
                    title={decentralizationDrag.detail ?? undefined}
                    className="pharos-focus-ring inline-flex items-center rounded-full border border-blue-500/25 bg-blue-500/10 px-2.5 py-0.5 text-[11px] font-medium text-blue-700 transition-colors hover:border-blue-500/45 hover:text-blue-900 dark:text-blue-300 dark:hover:text-blue-100"
                  >
                    Decentralization drag {decentralizationDrag.value}
                  </a>
                ) : (
                  <DetailBadge>Feeds Decentralization</DetailBadge>
                )}
                <span className="text-xs text-muted-foreground">MAS v1.2; Safety Score v8 penalty-only input</span>
                {score.capsApplied.map((cap) => (
                  <DetailBadge key={cap}>{cap}</DetailBadge>
                ))}
              </div>
            ) : null}

            <div className="flex flex-wrap gap-1.5">
              <DetailBadge>{profile.mintPathLabel}</DetailBadge>
              <DetailBadge>
                <span
                  aria-hidden
                  className={cn("h-1.5 w-1.5 shrink-0 rounded-full", POSTURE_DOT_CLASS[profile.authorityPostureTone])}
                />
                {profile.authorityPostureLabel}
              </DetailBadge>
              <DetailBadge>
                {profile.confidenceVerified ? <CircleCheck aria-hidden /> : <CircleDashed aria-hidden />}
                Confidence: {profile.confidenceLabel}
              </DetailBadge>
              {profile.inheritedFrom ? <DetailBadge>Inherited from {profile.inheritedFrom}</DetailBadge> : null}
            </div>

            <p className="text-sm leading-relaxed text-muted-foreground">{profile.summary}</p>

            {profile.mintIncidents.length > 0 ? (
              <div className="flex gap-2 rounded-lg border border-red-500/25 bg-red-500/8 px-3 py-2 text-sm text-red-700 dark:text-red-300">
                <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  {profile.mintIncidents.length > 1 ? (
                    <p className="pb-1 font-medium">Repeat mint incidents ({profile.mintIncidents.length})</p>
                  ) : null}
                  <div className="divide-y divide-red-500/20">
                    {profile.mintIncidents.map((incident) => (
                      <div key={incident.date} className="py-1.5 first:pt-0 last:pb-0">
                        <p className="font-medium">
                          {profile.mintIncidents.length > 1 ? incident.date : `Mint incident ${incident.date}`}
                        </p>
                        <p className="mt-0.5 text-xs leading-relaxed text-red-700/85 dark:text-red-300/85">
                          {incident.summary}
                        </p>
                        <MintAuthorityIncidentSources sources={incident.sources} />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}

            {hasVerificationGaps ? (
              <div className="rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
                <p className="text-xs font-semibold uppercase tracking-[0.12em]">Verification gaps</p>
                {profile.sourceFreeRationale ? (
                  <p className="mt-1 text-xs leading-relaxed">{profile.sourceFreeRationale}</p>
                ) : null}
                {unresolvedQuestions.length > 0 ? (
                  <ul className="mt-1 list-disc space-y-1 pl-4 text-xs leading-relaxed">
                    {unresolvedQuestions.map((question) => (
                      <li key={question}>{question}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {score ? <MintAuthorityScoreBreakdown score={score} /> : null}

            {profile.controls.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Primary controls
                </p>
                <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60 bg-muted/15">
                  {profile.controls.map((control) => (
                    <MintAuthorityControlRow key={control.key} control={control} />
                  ))}
                </ul>
              </div>
            ) : (
              <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                No primary control rows are published in the compact review summary.
              </div>
            )}

            {profile.sources.length > 0 ? (
              <div className="space-y-1.5">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Evidence sources
                </p>
                <div className="flex flex-wrap gap-x-3 gap-y-1.5 text-sm">
                  {profile.sources.map((source) => (
                    <a
                      key={`${source.label}:${source.url}`}
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
                    >
                      {source.label}
                      <ExternalLink aria-hidden className="h-3 w-3" />
                    </a>
                  ))}
                </div>
              </div>
            ) : null}

            <MethodologyCardActions
              topic="mintAuthorityScore"
              trailing={profile.reviewedAt ? `Reviewed ${profile.reviewedAt}` : undefined}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
