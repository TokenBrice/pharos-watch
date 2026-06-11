"use client";

import { ChevronDown, CircleCheck, CircleDashed, ExternalLink, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { MethodologyCardActions, MethodologyLabel } from "@/components/methodology-hint";
import { ScoreBadgeWrapper } from "@/components/score-badge-wrapper";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import type {
  MintAuthorityDetailControlViewModel,
  MintAuthorityDetailScoreViewModel,
  MintAuthorityDetailViewModel,
  MintAuthorityPostureTone,
} from "@/lib/stablecoin-detail-view-model";
import { cn } from "@/lib/utils";

const POSTURE_DOT_CLASS: Record<MintAuthorityPostureTone, string> = {
  minimized: "bg-[var(--brand-accent)]",
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
          <p className="truncate text-sm font-medium text-foreground">{control.label}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {control.roleLabel} / {control.authorityTypeLabel}
          </p>
        </div>
        {control.addressUrl ? (
          <a
            href={control.addressUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "pharos-focus-ring inline-flex items-center gap-1 transition-colors hover:text-foreground",
              locationClassName,
            )}
          >
            <span className="truncate">{control.locationLabel}</span>
            <ExternalLink aria-hidden className="h-3 w-3 shrink-0" />
          </a>
        ) : (
          <span className={cn("inline-flex truncate", locationClassName)}>{control.locationLabel}</span>
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

function MintAuthorityScoreBreakdown({ score }: { score: MintAuthorityDetailScoreViewModel }) {
  const controlSummary = [score.weakestControlLabel, score.weakestControlScoreLabel, score.weakestControlCustodyLabel]
    .filter(Boolean)
    .join(" / ");

  return (
    <details className="group">
      <summary className="pharos-focus-ring inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-md text-sm text-muted-foreground [&::-webkit-details-marker]:hidden lg:min-h-9">
        <span className="underline decoration-dashed underline-offset-2">Scoring breakdown</span>
        <ChevronDown aria-hidden="true" className="h-3 w-3 transition-transform group-open:rotate-180" />
      </summary>
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
    </details>
  );
}

export function MintAuthoritySection({ profile }: { profile?: MintAuthorityDetailViewModel | null }) {
  const isReviewed = profile?.status === "reviewed";
  if (!isReviewed || !profile) return null;
  const score = profile.score;

  return (
    <Card
      id="mint-authority"
      className="rounded-xl scroll-mt-[calc(10rem+var(--pharos-sticky-summary-h,0px))] lg:scroll-mt-6"
    >
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <DetailSectionTitle>
            <MethodologyLabel topic="mintAuthorityScore">Mint Authority</MethodologyLabel>
          </DetailSectionTitle>
          {score ? (
            <ScoreBadgeWrapper topic="mintAuthorityScore" variant="tooltip-only">
              <Badge
                variant="outline"
                className={cn("px-2.5 py-1 pharos-numeric text-lg", score.badgeClassName)}
                title={score.detail}
              >
                {score.scoreLabel}
              </Badge>
            </ScoreBadgeWrapper>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {score ? (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
            <span className={cn("text-sm font-medium", score.textClassName)}>{score.bandLabel}</span>
            <DetailBadge>Standalone score</DetailBadge>
            <span className="text-xs text-muted-foreground">Not a Safety Score input</span>
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

        {profile.mintIncident ? (
          <div className="flex gap-2 rounded-lg border border-red-500/25 bg-red-500/8 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">Mint incident {profile.mintIncident.date}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-red-700/85 dark:text-red-300/85">
                {profile.mintIncident.summary}
              </p>
            </div>
          </div>
        ) : null}

        {score ? <MintAuthorityScoreBreakdown score={score} /> : null}

        {profile.controls.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Primary controls</p>
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
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Evidence sources</p>
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
      </CardContent>
    </Card>
  );
}
