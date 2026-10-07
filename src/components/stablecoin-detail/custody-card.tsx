// src/components/stablecoin-detail/custody-card.tsx
"use client";

import { Check, CircleCheck, CircleDashed, Contrast, X, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { EvidenceModule, type EvidenceModuleVariant } from "@/components/stablecoin-detail/evidence-module";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { StationLabel } from "@/components/stablecoin-detail/rail-station";
import {
  formatCustodySharePct,
  isCustodyStructureUndisclosed,
  type CustodyClientSummary,
  type CustodyProtectionRung,
  type CustodyProtectionState,
  type CustodyShareSegment,
  type CustodyShareSegmentKind,
} from "@/lib/stablecoin-detail-custody-client";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";

/** Chips beyond this many collapse into "+N more"; the Providers fold lists all. */
const VISIBLE_PROVIDER_CHIPS = 6;

/**
 * Provider shares are a composition, not a graded level, so they stay neutral
 * (owner ruling 2026-08-11), stepping lighter by rank. Amber is reserved for
 * custody nobody has named; a hatch marks a share whose holder split is not
 * disclosed — never an empty or zero-width block.
 */
const PROVIDER_SEGMENT_FILLS = [
  "bg-foreground/75",
  "bg-foreground/55",
  "bg-foreground/40",
  "bg-foreground/28",
  "bg-foreground/18",
] as const;
const HATCHED_SEGMENT_FILL =
  "bg-muted-foreground/45 bg-[image:repeating-linear-gradient(135deg,var(--color-card)_0_1.5px,transparent_1.5px_4px)]";
const SEGMENT_FILL: Record<Exclude<CustodyShareSegmentKind, "provider">, string> = {
  unidentified: "bg-amber-500/60",
  unsplit: HATCHED_SEGMENT_FILL,
  unattributed: HATCHED_SEGMENT_FILL,
  undisclosed: SEVERITY_TONE_CLASS.watch.bar,
};

/** Track per rung state: lit, half-lit, empty with a solid edge (known absent), dashed (unknown). */
const RUNG_TRACK_CLASS: Record<CustodyProtectionState, string> = {
  met: SEVERITY_TONE_CLASS.ok.bar,
  partial: "bg-muted",
  failed: "border border-rose-500/60",
  unknown: "border border-dashed border-muted-foreground/50",
};

const RUNG_TEXT_CLASS: Record<CustodyProtectionState, string> = {
  met: SEVERITY_TONE_CLASS.ok.text,
  partial: SEVERITY_TONE_CLASS.watch.text,
  failed: SEVERITY_TONE_CLASS.rose.text,
  unknown: "text-muted-foreground",
};

const RUNG_ICON: Record<CustodyProtectionState, LucideIcon> = {
  met: Check,
  partial: Contrast,
  failed: X,
  unknown: CircleDashed,
};

/** Spoken before the value, so the glyph and hue are never the only carrier. */
const RUNG_STATE_SR: Record<CustodyProtectionState, string | null> = {
  met: "In place",
  partial: "Partly in place",
  failed: "Not in place",
  unknown: null,
};

function ShareBar({ segments }: { segments: readonly { segment: CustodyShareSegment; fill: string }[] }) {
  const label = segments.map(({ segment }) => `${segment.label} ${formatCustodySharePct(segment.pct)}`).join(", ");
  return (
    <div
      role="img"
      aria-label={`Custody share: ${label}.`}
      data-custody-share-bar=""
      className="flex h-2.5 w-full gap-px overflow-hidden rounded-full bg-muted"
    >
      {segments.map(({ segment, fill }) => (
        <span
          key={segment.key}
          data-segment-kind={segment.kind}
          title={`${segment.label}: ${formatCustodySharePct(segment.pct)}`}
          className={cn("h-full min-w-[2px]", fill)}
          style={{ width: `${segment.pct}%` }}
        />
      ))}
    </div>
  );
}

/**
 * Who holds the reserves: the share bar (when ≥ 2 segments exist), a chip per
 * named provider, then each unnamed holder as muted full text. An unnamed
 * holder is a reviewed description ("Systemically important and other
 * regulated banks (not individually disclosed)"), so it is never boxed or
 * truncated like a name. Provider segments take rank shades in bar order;
 * each chip, holder line and legend entry carries its segment's swatch.
 */
function HeldBy({ summary }: { summary: CustodyClientSummary }) {
  const segments = summary.shareSegments ?? [];
  const fills = segments.map((segment, index) => {
    if (segment.kind !== "provider") return { segment, fill: SEGMENT_FILL[segment.kind] };
    const providerRank = segments.slice(0, index).filter((earlier) => earlier.kind === "provider").length;
    return { segment, fill: PROVIDER_SEGMENT_FILLS[Math.min(providerRank, PROVIDER_SEGMENT_FILLS.length - 1)]! };
  });
  const swatchByHolder = new Map<string, string>();
  for (const { segment, fill } of fills) {
    for (const key of segment.providerKeys) swatchByHolder.set(key, fill);
  }
  const legend = fills.filter(({ segment }) => segment.kind !== "provider" && segment.kind !== "unidentified");
  const visibleProviders = summary.providers.slice(0, VISIBLE_PROVIDER_CHIPS);
  const hiddenCount = summary.providers.length - visibleProviders.length;
  // "Shares not disclosed" only means something when the reserves are split
  // across more than one holder and no bar draws the split.
  const sharesUnstated =
    fills.length === 0 && !summary.sharesDisclosed && summary.providers.length + summary.unnamedHolders.length > 1;
  const hasChipRow = visibleProviders.length > 0 || legend.length > 0 || sharesUnstated;

  return (
    <div className="space-y-2">
      <StationLabel>Held by</StationLabel>
      {fills.length > 0 ? <ShareBar segments={fills} /> : null}
      {hasChipRow ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {visibleProviders.length > 0 ? (
            <ul aria-label="Custody providers" className="flex min-w-0 flex-wrap items-start gap-1.5">
              {visibleProviders.map((provider) => {
                const swatch = swatchByHolder.get(provider.key);
                return (
                  <li
                    key={provider.key}
                    title={provider.name === provider.shortName ? undefined : provider.name}
                    data-custody-provider=""
                    className="inline-flex min-w-0 max-w-full items-start gap-1.5 rounded-md border border-border/60 px-2 py-1 text-xs font-medium leading-snug text-foreground"
                  >
                    {swatch ? <span aria-hidden="true" className={cn("mt-1 h-2 w-2 shrink-0 rounded-sm", swatch)} /> : null}
                    <span className="min-w-0 break-words">{provider.shortName}</span>
                    {provider.sharePct != null ? (
                      <span className="shrink-0 font-mono text-[11px] font-normal tabular-nums text-muted-foreground">
                        {formatCustodySharePct(provider.sharePct)}
                      </span>
                    ) : null}
                  </li>
                );
              })}
              {hiddenCount > 0 ? <li className="self-center text-xs text-muted-foreground">+{hiddenCount} more</li> : null}
            </ul>
          ) : null}
          {legend.map(({ segment, fill }) => (
            <span
              key={segment.key}
              data-legend-kind={segment.kind}
              className={cn(
                "inline-flex items-center gap-1.5 text-xs",
                segment.kind === "undisclosed" ? SEVERITY_TONE_CLASS.watch.text : "text-muted-foreground",
              )}
            >
              <span aria-hidden="true" className={cn("h-2 w-2 shrink-0 rounded-sm", fill)} />
              {segment.label}
              <span className="font-mono text-[11px] tabular-nums">{formatCustodySharePct(segment.pct)}</span>
            </span>
          ))}
          {sharesUnstated ? <span className="text-xs text-muted-foreground">Shares not disclosed</span> : null}
        </div>
      ) : null}
      {summary.unnamedHolders.length > 0 ? (
        <ul aria-label="Custodians not publicly named" className="space-y-1">
          {summary.unnamedHolders.map((holder) => {
            const swatch = swatchByHolder.get(holder.key);
            return (
              <li
                key={holder.key}
                data-custody-unnamed-holder=""
                className="flex items-start gap-1.5 text-xs leading-snug text-muted-foreground"
              >
                {swatch ? (
                  <span aria-hidden="true" className={cn("mt-1 h-2 w-2 shrink-0 rounded-sm", swatch)} />
                ) : (
                  <CircleDashed aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0" />
                )}
                <span className="min-w-0 text-pretty">{holder.description}</span>
                {holder.sharePct != null ? (
                  <span className="shrink-0 font-mono text-[11px] tabular-nums">{formatCustodySharePct(holder.sharePct)}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * One rung of the protection meter: lit (in place), half-lit (partly: mixed
 * accounts, contractual-only, conditional), empty on a solid edge (known
 * absent) or dashed (not established). Unknown is never drawn as failed.
 *
 * In a narrow container each rung is one row (label and value, track
 * beneath); from 25rem the three rungs stand side by side as a ladder. The
 * labels are sentence-case sans (no tracked capitals to wrap), sit on the
 * row's bottom edge, and a subgrid keeps the three tracks on one line even
 * when a label does wrap.
 */
function ProtectionRung({ rung }: { rung: CustodyProtectionRung }) {
  const Icon = RUNG_ICON[rung.state];
  const stateLabel = RUNG_STATE_SR[rung.state];
  return (
    <li
      data-rung={rung.key}
      data-rung-state={rung.state}
      className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 @[25rem]/meter:row-span-3 @[25rem]/meter:grid-cols-1 @[25rem]/meter:grid-rows-subgrid @[25rem]/meter:items-start"
    >
      <span className="col-start-1 row-start-1 min-w-0 text-xs font-medium leading-tight text-muted-foreground @[25rem]/meter:self-end">
        {rung.label}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "relative col-span-2 row-start-2 h-1.5 overflow-hidden rounded-full @[25rem]/meter:col-span-1",
          RUNG_TRACK_CLASS[rung.state],
        )}
      >
        {rung.state === "partial" ? (
          <span className={cn("absolute inset-y-0 left-0 w-1/2 rounded-full", SEVERITY_TONE_CLASS.watch.bar)} />
        ) : null}
      </span>
      <span
        className={cn(
          "col-start-2 row-start-1 inline-flex min-w-0 items-start gap-1 justify-self-end text-xs font-medium leading-snug",
          "@[25rem]/meter:col-start-1 @[25rem]/meter:row-start-3 @[25rem]/meter:justify-self-start",
          RUNG_TEXT_CLASS[rung.state],
        )}
      >
        <Icon aria-hidden="true" className="mt-px h-3 w-3 shrink-0" />
        <span className="min-w-0">
          {stateLabel ? <span className="sr-only">{stateLabel}: </span> : null}
          {rung.valueLabel}
        </span>
      </span>
    </li>
  );
}

/**
 * Who holds the reserves, under what legal structure: the reviewed
 * `custodyProfile` as a Backing-board evidence module owning `#custody`.
 *
 * - The header chip is read off the protection meter (`postureKey`), so it
 *   never says "Undisclosed" beside a lit rung or a named custodian.
 * - Visual: named provider chips, unnamed holders as muted full text, a
 *   stacked share bar only when the review publishes at least two share
 *   segments, and the three-rung protection meter. The meter is dropped when
 *   the review establishes none of the three structure facts; the header
 *   chip then reads "Structure undisclosed".
 * - Nothing named, nothing established and no share to draw (USDT): the
 *   module is forced to strip form and its body is one line, "Custody
 *   structure undisclosed", with the provenance fold and review date on the
 *   same row. The placeholder holder is not repeated.
 *
 * Wide strips split the body (the visual left, verdict and folds right) in
 * `EvidenceModule`; in strip form the provenance fold and the review date
 * share one row. Renders nothing when no custody review exists; the caller
 * owns any "Not reviewed" state.
 */
export function CustodyModule({
  summary,
  variant,
  stripForm,
}: {
  summary?: CustodyClientSummary | null;
  variant: EvidenceModuleVariant;
  stripForm?: boolean;
}) {
  if (!summary) return null;

  const structureUndisclosed = isCustodyStructureUndisclosed(summary);
  const degraded = structureUndisclosed && summary.providers.length === 0 && summary.shareSegments == null;
  const headerChip = (
    <Badge variant="outline" className={cn("text-[11px] font-medium", summary.postureToneClass)}>
      {summary.postureLabel}
    </Badge>
  );
  const footerProps = {
    sources: summary.sources.map((source) => ({ label: source.label, url: source.url })),
    notes: summary.uncertainty ? <p>{summary.uncertainty}</p> : undefined,
    notesCount: summary.uncertainty ? 1 : undefined,
    foldId: "custody-review-notes",
    reviewed: summary.reviewedAt || undefined,
  };

  if (degraded) {
    return (
      <EvidenceModule
        id="custody"
        title="Custody"
        variant={variant}
        stripForm
        headerRight={headerChip}
        footer={
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <p data-custody-undisclosed="" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
              <CircleDashed aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              Custody structure undisclosed
            </p>
            {/* Basis auto: a closed fold sits beside the line; an opened one wraps under it at full width. */}
            <EvidenceFooter {...footerProps} inline className="min-w-0 flex-auto" />
          </div>
        }
      />
    );
  }

  const showHeldBy =
    summary.providers.length > 0 || summary.unnamedHolders.length > 0 || summary.shareSegments != null;

  return (
    <EvidenceModule
      id="custody"
      title="Custody"
      variant={variant}
      stripForm={stripForm}
      headerRight={headerChip}
      visual={
        <div className={stripForm ? "space-y-3" : "space-y-4"}>
          {showHeldBy ? <HeldBy summary={summary} /> : null}
          {structureUndisclosed ? null : (
            <div className="@container/meter">
              <ol
                aria-label="Custody protections"
                className="grid gap-2.5 @[25rem]/meter:grid-cols-3 @[25rem]/meter:gap-x-4 @[25rem]/meter:gap-y-1.5"
              >
                {summary.protection.map((rung) => <ProtectionRung key={rung.key} rung={rung} />)}
              </ol>
            </div>
          )}
        </div>
      }
      verdict={summary.summary}
      chipRow={
        <Badge variant="outline" className="border-border/60 bg-muted/30 text-[11px] font-medium text-muted-foreground">
          {summary.confidenceVerified ? <CircleCheck aria-hidden="true" /> : <CircleDashed aria-hidden="true" />}
          Confidence: {summary.confidenceLabel}
        </Badge>
      }
      footer={<EvidenceFooter {...footerProps} inline={stripForm} />}
    >
      {summary.providers.length > 0 ? (
        <ModuleDisclosure label="Providers" count={summary.providers.length}>
          <ul aria-label="All custody providers" className="mt-2 divide-y divide-border/50 pb-1">
            {summary.providers.map((provider) => (
              <li key={provider.key} className="flex items-baseline justify-between gap-3 py-1.5">
                <div className="min-w-0">
                  <p className="break-words text-xs text-foreground">{provider.name}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {provider.roleLabel}
                    {provider.jurisdiction ? ` · ${provider.jurisdiction}` : ""}
                  </p>
                </div>
                {provider.sharePct != null ? (
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                    {formatCustodySharePct(provider.sharePct)}
                  </span>
                ) : (
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    <span aria-hidden="true">–</span>
                    <span className="sr-only">Share not disclosed</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </ModuleDisclosure>
      ) : null}
    </EvidenceModule>
  );
}
