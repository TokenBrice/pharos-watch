"use client";

import { CircleCheck, CircleDashed, ExternalLink, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { MethodologyLabel } from "@/components/methodology-hint";
import { ScoreBadgeWrapper } from "@/components/score-badge-wrapper";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { MintAuthorityRail } from "@/components/stablecoin-detail/mint-authority-rail";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { ScoreBandSpectrum, type SpectrumBand } from "@/components/stablecoin-detail/score-band-spectrum";
import { ScorePill } from "@/components/stablecoin-detail/score-pill";
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
import { cn } from "@/lib/utils";

const POSTURE_DOT_CLASS: Record<MintAuthorityPostureTone, string> = {
  minimized: "bg-[var(--severity-healthy)]",
  neutral: "bg-[var(--text-tertiary)]",
  elevated: "bg-[var(--severity-mild)]",
};

/** The five published V9 posture bands — ordinal, not score ranges: 9.1
 *  retired the score cutoffs, so the ladder lights the published band rather
 *  than positioning a marker on a fictional scale. Rendered worst → best so
 *  "right = safer" reads the same as the redemption score track. */
const MINT_BAND_SPECTRUM: readonly SpectrumBand[] = [
  { key: "exposed", label: "Exposed", fillClass: "bg-red-500/70", textClass: "text-red-700 dark:text-red-400" },
  { key: "concentrated", label: "Concentrated", fillClass: "bg-orange-500/70", textClass: "text-orange-700 dark:text-orange-400" },
  { key: "managed", label: "Managed", fillClass: "bg-amber-500/70", textClass: "text-amber-700 dark:text-amber-400" },
  { key: "governed", label: "Governed", fillClass: "bg-blue-500/70", textClass: "text-blue-700 dark:text-blue-400" },
  { key: "hardened", label: "Hardened", fillClass: "bg-emerald-500/70", textClass: "text-emerald-700 dark:text-emerald-400" },
];

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
  tone = "alert",
}: {
  sources: MintAuthorityDetailViewModel["mintIncidents"][number]["sources"];
  tone?: "alert" | "muted";
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
          className={cn(
            "pharos-focus-ring inline-flex items-center gap-1 rounded-sm underline underline-offset-2 transition-colors",
            tone === "alert" ? "hover:text-red-900 dark:hover:text-red-100" : "hover:text-foreground",
          )}
        >
          {source.label}
          <ExternalLink aria-hidden className="h-3 w-3" />
        </a>
      ))}
    </div>
  );
}

function MintAuthorityScoreBreakdown({ score }: { score: MintAuthorityDetailScoreViewModel }) {
  return (
    <ScoringBreakdownDisclosure>
      <div className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
        <div className="rounded-lg border border-border/60 px-3 py-2">
          <span className="font-medium text-foreground">Derived posture</span>{" "}
          <span className={score.textClassName}>{score.postureLabel}</span>
        </div>
        <div className="rounded-lg border border-border/60 px-3 py-2">
          <span className="font-medium text-foreground">Component score</span>{" "}
          <span className="pharos-numeric">{score.scoreLabel}</span>
        </div>
        {score.caps.length > 0 ? (
          <div className="rounded-lg border border-border/60 px-3 py-2 sm:col-span-2">
            <span className="font-medium text-foreground">Structural caps</span>
            <ul className="mt-1 space-y-1">
              {score.caps.map((cap) => (
                <li key={cap.kind}>
                  {cap.label} <span className="pharos-numeric">{cap.limitLabel}</span> — {cap.reason}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="sm:col-span-2">{score.detail}</p>
      </div>
    </ScoringBreakdownDisclosure>
  );
}

export function MintAuthoritySection({
  profile,
  symbol,
}: {
  profile?: MintAuthorityDetailViewModel | null;
  /** Token symbol for the mint rail's supply station. */
  symbol?: string | null;
}) {
  if (!profile) return null;
  const isReviewed = profile.status === "reviewed";
  const score = profile.score;
  const railControls = profile.controls ?? [];
  const hasRail = Boolean(symbol) && railControls.length > 0 && profile.mintPathShortLabel !== "Unknown";
  const hasSpectrum = score != null && score.bandKey != null && score.bandKey !== "nr";
  const scoreTriggerLabel = score
    ? `Mint Authority Score ${score.scoreLabel}, ${score.bandLabel}. Explain methodology.`
    : undefined;
  const unresolvedQuestions = profile.unresolvedQuestions ?? [];
  const hasVerificationGaps = !!profile.sourceFreeRationale || unresolvedQuestions.length > 0;
  const mintIncidents = profile.mintIncidents ?? [];
  const activeIncidents = mintIncidents.filter((incident) => incident.status === "active");
  const resolvedIncidents = mintIncidents.filter((incident) => incident.status !== "active");

  return (
    <Card id="mint-authority" className={cn(DETAIL_MODULE_SHELL_CLASS, SECTION_SCROLL_MT)}>
      <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <DetailSectionTitle className={DETAIL_MODULE_TITLE_CLASS}>
            <MethodologyLabel topic="mintAuthorityScore">Mint Authority</MethodologyLabel>
          </DetailSectionTitle>
          {score ? (
            <ScoreBadgeWrapper topic="mintAuthorityScore" variant="tooltip-only" triggerAriaLabel={scoreTriggerLabel}>
              <ScorePill label={score.scoreLabel} toneClass={score.badgeClassName} title={score.detail} />
            </ScoreBadgeWrapper>
          ) : (
            <ScorePill label="NR" title="The mint control posture is not rated." />
          )}
        </div>
      </CardHeader>
      <CardContent className={cn(DETAIL_MODULE_BODY_CLASS, "space-y-4")}>
        {!isReviewed ? (
          <>
            <div className="flex flex-wrap gap-1.5">
              <DetailBadge>{profile.reviewLabel}</DetailBadge>
              <DetailBadge>Mint control posture: NR</DetailBadge>
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">{profile.summary}</p>
            <EvidenceFooter topic="mintAuthorityScore" />
          </>
        ) : (
          <>
            {hasSpectrum ? (
              <ScoreBandSpectrum
                mode="ordinal"
                bands={MINT_BAND_SPECTRUM}
                activeKey={score.bandKey}
                ariaLabel={`Mint posture band: ${score.bandLabel}, on the five-band ladder from Hardened to Exposed.`}
              />
            ) : null}

            {hasRail ? (
              <MintAuthorityRail
                symbol={symbol!}
                mintPathShortLabel={profile.mintPathShortLabel}
                mintPathLabel={profile.mintPathLabel}
                postureLabel={profile.authorityPostureLabel}
                postureTone={profile.authorityPostureTone}
                controls={railControls}
              />
            ) : null}

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              {score && !hasSpectrum ? (
                <span className={cn("text-sm font-medium", score.textClassName)}>{score.bandLabel}</span>
              ) : null}
              {/* The rail's issuer and supply stations absorb these two facts. */}
              {!hasRail ? <DetailBadge>{profile.mintPathLabel}</DetailBadge> : null}
              {!hasRail ? (
                <DetailBadge>
                  <span
                    aria-hidden
                    className={cn("h-1.5 w-1.5 shrink-0 rounded-full", POSTURE_DOT_CLASS[profile.authorityPostureTone])}
                  />
                  {profile.authorityPostureLabel}
                </DetailBadge>
              ) : null}
              <DetailBadge>
                {profile.confidenceVerified ? <CircleCheck aria-hidden /> : <CircleDashed aria-hidden />}
                Confidence: {profile.confidenceLabel}
              </DetailBadge>
              {profile.inheritedFrom ? <DetailBadge>Inherited from {profile.inheritedFrom}</DetailBadge> : null}
            </div>

            <p className="text-sm leading-relaxed text-muted-foreground">{profile.summary}</p>

            {activeIncidents.length > 0 ? (
              <div className="flex gap-2 rounded-lg border border-red-500/25 bg-red-500/8 px-3 py-2 text-sm text-red-700 dark:text-red-300">
                <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  {activeIncidents.length > 1 ? (
                    <p className="pb-1 font-medium">Active mint incidents ({activeIncidents.length})</p>
                  ) : null}
                  <div className="divide-y divide-red-500/20">
                    {activeIncidents.map((incident) => (
                      <div key={incident.date} className="py-1.5 first:pt-0 last:pb-0">
                        <p className="font-medium">
                          {activeIncidents.length > 1 ? incident.date : `Mint incident ${incident.date}`}
                          <span className="ml-2 text-xs font-semibold uppercase">Active</span>
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

            {score ? <MintAuthorityScoreBreakdown score={score} /> : null}

            {railControls.length > 0 ? (
              <ModuleDisclosure label="Primary controls" count={railControls.length}>
                <div className="mt-2 space-y-3">
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
                  <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60 bg-muted/15">
                    {railControls.map((control) => (
                      <MintAuthorityControlRow key={control.key} control={control} />
                    ))}
                  </ul>
                </div>
              </ModuleDisclosure>
            ) : (
              <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                No primary control rows are published in the compact review summary.
              </div>
            )}

            {resolvedIncidents.length > 0 ? (
              /* Historical record, not an alarm: resolved incidents read as a
                 calm folded ledger — red stays reserved for active state. */
              <ModuleDisclosure label="Incident history" count={resolvedIncidents.length}>
                <div className="mt-2 divide-y divide-border/50 rounded-lg border border-border/60 bg-muted/15 px-3 text-sm text-muted-foreground">
                  {resolvedIncidents.map((incident) => (
                    <div key={incident.date} className="py-2.5">
                      <p className="font-medium text-foreground">
                        Mint incident {incident.date}
                        <span className="ml-2 text-xs font-semibold uppercase text-muted-foreground">Resolved</span>
                      </p>
                      {incident.resolvedAt && incident.resolvedAt !== incident.date ? (
                        <p className="mt-0.5 text-xs">Resolved {incident.resolvedAt}</p>
                      ) : null}
                      <p className="mt-0.5 text-xs leading-relaxed">{incident.summary}</p>
                      <MintAuthorityIncidentSources sources={incident.sources} tone="muted" />
                    </div>
                  ))}
                </div>
              </ModuleDisclosure>
            ) : null}

            <EvidenceFooter
              topic="mintAuthorityScore"
              sources={profile.sources}
              trailing={profile.reviewedAt ? `Reviewed ${profile.reviewedAt}` : undefined}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
