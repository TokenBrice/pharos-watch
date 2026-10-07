"use client";

import Link from "next/link";
import { CircleCheck, CircleDashed, ExternalLink, Link2, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { MethodologyHint } from "@/components/methodology-hint";
import { ScoreBadgeWrapper } from "@/components/score-badge-wrapper";
import { ControlRoleTag } from "@/components/stablecoin-detail/control-role-tag";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { EvidenceModule, type EvidenceModuleVariant } from "@/components/stablecoin-detail/evidence-module";
import { FactGrid } from "@/components/stablecoin-detail/fact-grid";
import { MintAuthorityRail } from "@/components/stablecoin-detail/mint-authority-rail";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { ScoreBandSpectrum, type SpectrumBand } from "@/components/stablecoin-detail/score-band-spectrum";
import { ScorePill } from "@/components/stablecoin-detail/score-pill";
import { ScoringBreakdownDisclosure } from "@/components/stablecoin-detail/scoring-breakdown-disclosure";
import { SECTION_SCROLL_MT } from "@/components/stablecoin-detail/section-title-class";
import type { ControlPostureView } from "@/lib/control-posture";
import type {
  MintAuthorityDetailControlViewModel,
  MintAuthorityDetailScoreViewModel,
  MintAuthorityDetailViewModel,
} from "@/lib/stablecoin-detail-mint-authority-view-model";
import { MINT_AUTHORITY_TONE_NOTE } from "@/lib/mint-authority-display";
import {
  groupMintIssuanceDiagnostics,
  type MintIssuanceDiagnosticGroup,
  type MintIssuanceDiagnosticStatus,
  type MintIssuanceDiagnosticsView,
} from "@/lib/mint-issuance-diagnostics";
import type { ControlComponentRoles } from "@/lib/pillar-evidence-strips";
import { cn } from "@/lib/utils";
import { MINT_AUTHORITY_POSTURE_DOT_CLASS } from "@/components/stablecoin-detail/mint-authority-presentation";

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

/**
 * Diagnostic status chips carry their meaning in the status word and the
 * outline pattern, not in hue: a failure is a solid foreground outline,
 * missing proof is dashed (unknown, not failed), and an analytical note is a
 * quiet fill. Red stays reserved for active incidents.
 */
const DIAGNOSTIC_STATUS_CHIP_CLASS: Record<MintIssuanceDiagnosticStatus, string> = {
  "Failed gate": "border-foreground/70 font-semibold text-foreground",
  "Failed screen": "border-foreground/70 font-semibold text-foreground",
  "Missing evidence": "border-dashed border-muted-foreground/50 text-muted-foreground",
  "Analytical note": "border-transparent bg-muted/50 text-muted-foreground",
};

/** Control names printed per diagnostic row before "+N more". */
const MAX_DIAGNOSTIC_CONTROL_NAMES = 3;

function DetailBadge({
  children,
  className,
  id,
  title,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
  title?: string;
}) {
  return (
    <Badge
      id={id}
      title={title}
      variant="outline"
      className={cn("border-border/60 bg-muted/30 text-[11px] font-medium text-muted-foreground", className)}
    >
      {children}
    </Badge>
  );
}

/**
 * The coin's descriptive control posture ("Regulated entity"), owning
 * `#control-posture`. Neutral like the other chips: posture is a
 * classification, not a Safety Score input, so it takes no state hue.
 */
function ControlPostureChip({ posture }: { posture: ControlPostureView }) {
  return (
    <DetailBadge
      id="control-posture"
      title="Descriptive classification; not a Safety Score input"
      className={SECTION_SCROLL_MT}
    >
      Control posture: {posture.label}
    </DetailBadge>
  );
}

/** The posture's explanation, appended to the module's Review notes & sources fold. */
function ControlPostureNotes({ posture }: { posture: ControlPostureView }) {
  return (
    <section className="space-y-1">
      <h4 className="font-semibold text-foreground">Control posture</h4>
      {posture.details.map((detail) => (
        <p key={detail} className="max-w-[75ch]">{detail}</p>
      ))}
    </section>
  );
}

function ControlMeta({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</span>
      <span className="text-xs text-foreground">{value}</span>
    </span>
  );
}

function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : pluralNoun}`;
}

/** Where a diagnostic row's findings sit, as counts and control names (never refs or ids). */
function describeDiagnosticScope(group: MintIssuanceDiagnosticGroup): string | null {
  const parts: string[] = [];
  if (group.controlLabels.length > 0) {
    const shown = group.controlLabels.slice(0, MAX_DIAGNOSTIC_CONTROL_NAMES);
    const more = group.controlCount - shown.length;
    parts.push(`${shown.join(", ")}${more > 0 ? ` + ${plural(more, "more control", "more controls")}` : ""}`);
  } else if (group.controlCount > 0) {
    parts.push(plural(group.controlCount, "control"));
  }
  if (group.processLevel) parts.push("Process-level");
  if (group.classCount > 0) parts.push(plural(group.classCount, "execution class", "execution classes"));
  if (group.evidenceRefCount > 0) parts.push(`Cites ${plural(group.evidenceRefCount, "evidence reference")}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function MintIssuanceDiagnosticRow({ group }: { group: MintIssuanceDiagnosticGroup }) {
  const scope = describeDiagnosticScope(group);
  // A per-field count only adds information when the row splits across fields.
  const showFieldCounts = group.fields.length > 1;

  return (
    <li className="px-3 py-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
          <span
            className={cn(
              "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-tight",
              DIAGNOSTIC_STATUS_CHIP_CLASS[group.status],
            )}
          >
            {group.status}
          </span>
          <span className="font-medium text-foreground">{group.reasonLabel}</span>
        </p>
        <span className="pharos-numeric shrink-0 text-xs text-muted-foreground">{plural(group.count, "finding")}</span>
      </div>
      {group.fields.length > 0 ? (
        <ul aria-label="Affected fields" className="mt-1.5 flex flex-wrap gap-1.5">
          {group.fields.map((field) => (
            <li
              key={field.label}
              className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/70 px-1.5 py-0.5 text-[11px] text-muted-foreground"
            >
              {field.label}
              {showFieldCounts && field.count > 1 ? (
                <span className="pharos-numeric text-foreground/80">×{field.count}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {scope ? <p className="mt-1.5 text-xs text-muted-foreground">{scope}</p> : null}
    </li>
  );
}

/**
 * Published issuance-process diagnostics, folded after Primary controls.
 * Groups that share a status and reason collapse into one row with a finding
 * count and their affected fields merged by label, so a coin publishing dozens
 * of per-route groups reads as a handful of reasons. Gate codes, class ids,
 * path ids and evidence ids stay out of the page; their counts stay in.
 * Absent evidence renders nothing.
 */
function MintIssuanceDiagnostics({
  view,
  metrics,
}: {
  view: MintIssuanceDiagnosticsView;
  metrics: MintAuthorityDetailViewModel["processMetrics"];
}) {
  const { groups, total, statusCounts } = view;
  if (groups.length === 0 && metrics.length === 0) return null;
  return (
    <ModuleDisclosure
      id="mint-issuance-diagnostics"
      label="Issuance diagnostics"
      count={groups.length > 0 ? groups.length : undefined}
    >
      <div className="mt-2 space-y-3">
        {groups.length > 0 ? (
          <>
            <p className="text-xs text-muted-foreground">
              {plural(total, "finding")} across {plural(groups.length, "reason")}:{" "}
              {statusCounts.map(({ status, count }) => `${count} ${status.toLowerCase()}`).join(", ")}.
            </p>
            <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60 bg-muted/15">
              {groups.map((group) => (
                <MintIssuanceDiagnosticRow key={group.key} group={group} />
              ))}
            </ul>
          </>
        ) : null}
        {metrics.length > 0 ? (
          <dl className="grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
            {metrics.map((metric) => (
              <div key={metric.label} className="flex min-w-0 flex-wrap justify-between gap-x-3">
                <dt className="text-muted-foreground">{metric.label}</dt>
                <dd className="pharos-numeric text-foreground">{metric.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </ModuleDisclosure>
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

/**
 * Whether the module has anything to render: a review, or published issuance
 * diagnostics for an unreviewed coin. When false, `MintAuthoritySection`
 * renders nothing and the page shows its own "Not reviewed" state.
 */
export function hasMintAuthorityModuleData(profile: MintAuthorityDetailViewModel | null | undefined): boolean {
  if (!profile) return false;
  return profile.status === "reviewed" || profile.processDiagnostics.length > 0 || profile.processMetrics.length > 0;
}

/**
 * Mint Authority, the Control pillar's signature module (plan §8a): band
 * ladder + Issuer → Controls → Supply rail, generated verdict, chip row, then
 * the folds in fixed order — Scoring breakdown → Primary controls → Issuance
 * diagnostics → Incident history → Review notes & sources — and one footer
 * line (Reviewed date right; the methodology link lives in the title's (?)).
 * The body always stacks: the ladder and the rail keep the module's full
 * width at every breakpoint (a split squeezed the rail's station labels), and
 * the folds sit in one column in their fixed order. The anchor
 * `#mint-authority` sits on the module; `#mint-primary-controls`,
 * `#mint-issuance-diagnostics` and `#mint-review-notes` sit on their folds.
 * The coin's descriptive control posture rides in the chip row, where its
 * chip owns `#control-posture`, and its explanation joins the Review notes
 * & sources fold under a "Control posture" subheading.
 */
export function MintAuthoritySection({
  profile,
  symbol,
  controlRoles,
  controlPosture = null,
  variant = "module",
  stripForm = false,
}: {
  profile?: MintAuthorityDetailViewModel | null;
  /** Token symbol for the mint rail's supply station. */
  symbol?: string | null;
  /**
   * Control-pillar roles from `resolveControlComponentRoles(card)`. The mint
   * component earns the "Limiting input" tag only at the eligible minimum; an
   * eligible component above it gets no tag, a non-binding one reads as a diagnostic.
   */
  controlRoles?: ControlComponentRoles | null;
  /** `buildControlPostureView(coin, parent)`: descriptive, not a Safety Score input. */
  controlPosture?: ControlPostureView | null;
  variant?: EvidenceModuleVariant;
  stripForm?: boolean;
}) {
  if (!profile || !hasMintAuthorityModuleData(profile)) return null;
  const isReviewed = profile.status === "reviewed";
  const score = profile.score;
  const railControls = profile.controls ?? [];
  const totalControlCount = profile.totalControlCount ?? railControls.length;
  const omittedControlCount = totalControlCount - railControls.length;
  const hasRail = Boolean(symbol) && railControls.length > 0 && profile.mintPathShortLabel !== "Unknown";
  const hasSpectrum = score != null && score.bandKey != null && score.bandKey !== "nr";
  const scoreTriggerLabel = score
    ? `Mint Authority Score ${score.scoreLabel}, ${score.bandLabel}. Explain methodology.`
    : undefined;
  const mintRole = controlRoles?.components.find((component) => component.kind === "mint")?.role ?? null;
  const unresolvedQuestions = profile.unresolvedQuestions ?? [];
  const hasVerificationGaps = !!profile.sourceFreeRationale || unresolvedQuestions.length > 0;
  const mintIncidents = profile.mintIncidents ?? [];
  const activeIncidents = mintIncidents.filter((incident) => incident.status === "active");
  const resolvedIncidents = mintIncidents.filter((incident) => incident.status !== "active");
  // Diagnostics matched to a rendered control ride on that control; the fold
  // lists every published group once and names the controls it touches.
  const issuanceDiagnostics = groupMintIssuanceDiagnostics(
    [...profile.processDiagnostics, ...railControls.flatMap((control) => control.processDiagnostics)],
    railControls,
  );
  const issuanceDiagnosticsFold = (
    <MintIssuanceDiagnostics view={issuanceDiagnostics} metrics={profile.processMetrics} />
  );

  const headerRight = (
    <>
      {score ? (
        <ScoreBadgeWrapper topic="mintAuthorityScore" variant="tooltip-only" triggerAriaLabel={scoreTriggerLabel}>
          <ScorePill
            label={score.compactLabel}
            toneClass={score.badgeClassName}
            title={`${score.detail} ${MINT_AUTHORITY_TONE_NOTE}`}
          />
        </ScoreBadgeWrapper>
      ) : (
        <ScorePill label="NR" title="The mint control posture is not rated." />
      )}
      <ControlRoleTag role={mintRole} />
    </>
  );
  const methodology = <MethodologyHint topic="mintAuthorityScore" />;
  const postureChip = controlPosture ? <ControlPostureChip posture={controlPosture} /> : null;
  const postureNotes = controlPosture ? <ControlPostureNotes posture={controlPosture} /> : null;

  if (!isReviewed) {
    // Published diagnostics without a review: nothing to draw, so the module
    // keeps its strip form and states the missing review in the chip row.
    return (
      <EvidenceModule
        id="mint-authority"
        title="Mint Authority"
        variant={variant}
        stripForm
        methodology={methodology}
        headerRight={headerRight}
        verdict={profile.summary}
        chipRow={
          <>
            <DetailBadge>{profile.reviewLabel}</DetailBadge>
            {postureChip}
          </>
        }
        folds={issuanceDiagnosticsFold}
        footer={
          postureNotes ? <EvidenceFooter notes={postureNotes} notesCount={1} foldId="mint-review-notes" /> : undefined
        }
      />
    );
  }

  const visual = hasSpectrum || hasRail ? (
    <div className="space-y-4">
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
          totalControlCount={totalControlCount}
        />
      ) : null}
    </div>
  ) : null;

  const chipRow = (
    <>
      <DetailBadge>
        {profile.confidenceVerified ? <CircleCheck aria-hidden /> : <CircleDashed aria-hidden />}
        Confidence: {profile.confidenceLabel}
      </DetailBadge>
      {profile.inheritedFrom ? (
        <Link
          href={profile.inheritedFrom.href}
          title={`This score rates ${symbol ?? "this token"}'s own mint controls; underlying supply follows ${profile.inheritedFrom.symbol}'s mint authority.`}
          className="pharos-focus-ring rounded-md"
        >
          <DetailBadge className="transition-colors hover:text-foreground">
            <Link2 aria-hidden />
            Inherits {profile.inheritedFrom.symbol} mint risk
          </DetailBadge>
        </Link>
      ) : null}
      {postureChip}
    </>
  );
  const reviewNoteCount = (profile.summary ? 1 : 0) + (postureNotes ? 1 : 0);

  return (
    <EvidenceModule
      id="mint-authority"
      title="Mint Authority"
      variant={variant}
      // Without the ladder or the rail there is nothing to draw: one row.
      stripForm={stripForm || visual === null}
      methodology={methodology}
      headerRight={headerRight}
      visual={visual}
      // Strip form included: the rail never shares its width with the verdict.
      bodyLayout="stack"
      verdict={profile.verdict}
      chipRow={chipRow}
      folds={
        <>
          {score ? <MintAuthorityScoreBreakdown score={score} /> : null}
          {railControls.length > 0 ? (
            <ModuleDisclosure id="mint-primary-controls" label="Primary controls" count={totalControlCount}>
              <div className="mt-2 space-y-3">
                {hasVerificationGaps ? (
                  <div className="rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
                    <p className="text-xs font-semibold">Verification gaps</p>
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
                {omittedControlCount > 0 ? (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Showing {railControls.length} of {totalControlCount} primary controls
                    {profile.controlCensusUrl ? (
                      <>
                        {" · "}
                        <a
                          href={profile.controlCensusUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="pharos-focus-ring rounded-sm text-foreground underline underline-offset-2"
                        >
                          {omittedControlCount} more in the full control census
                        </a>
                      </>
                    ) : (
                      ` · ${omittedControlCount} more not listed`
                    )}
                  </p>
                ) : null}
              </div>
            </ModuleDisclosure>
          ) : null}
          {issuanceDiagnosticsFold}
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
        </>
      }
      footer={
        <EvidenceFooter
          sources={profile.sources}
          notes={
            reviewNoteCount > 0 ? (
              <>
                {profile.summary ? <p>{profile.summary}</p> : null}
                {postureNotes}
              </>
            ) : undefined
          }
          notesCount={reviewNoteCount > 0 ? reviewNoteCount : undefined}
          foldId="mint-review-notes"
          reviewed={profile.reviewedAt ?? undefined}
        />
      }
    >
      {/* The rail's issuer and supply stations carry these two facts when it draws. */}
      {!hasRail ? (
        <FactGrid
          aria-label="Mint path and authority posture"
          items={[
            { key: "path", label: "Mint path", value: profile.mintPathLabel, valueStyle: "text" },
            {
              key: "posture",
              label: "Authority posture",
              valueStyle: "text",
              value: (
                <span className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      MINT_AUTHORITY_POSTURE_DOT_CLASS[profile.authorityPostureTone],
                    )}
                  />
                  {profile.authorityPostureLabel}
                </span>
              ),
            },
          ]}
        />
      ) : null}

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

      {railControls.length === 0 ? (
        <p className="pharos-empty-note text-xs text-muted-foreground">
          No primary control rows are published in the compact review summary.
        </p>
      ) : null}
    </EvidenceModule>
  );
}
