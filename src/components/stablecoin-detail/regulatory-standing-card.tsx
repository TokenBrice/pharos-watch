// src/components/stablecoin-detail/regulatory-standing-card.tsx
"use client";

import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { EvidenceModule } from "@/components/stablecoin-detail/evidence-module";
import { FactGrid, type FactGridItem } from "@/components/stablecoin-detail/fact-grid";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { RailCard } from "@/components/stablecoin-detail/rail-card";
import { SourceLinkList } from "@/components/stablecoin-detail/source-link-list";
import { Badge } from "@/components/ui/badge";
import type {
  IssuerDisclosureRow,
  IssuerDisclosureState,
  RegulatoryRegimeView,
  RegulatoryStandingView,
} from "@/lib/regulatory-standing";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";

/** The passport's Jurisdiction and MiCA cells jump here. */
const JURISDICTION_ANCHOR_ID = "jurisdiction";
const TITLE = "Regulatory standing";

/**
 * Tone by meaning, never by regime: a published disclosure is a neutral fact
 * (not a compliance tick), a reviewed absence or a below-monthly attestation
 * is a watch finding, and a missing record stays muted because unavailable is
 * not a failure.
 */
const DISCLOSURE_STATE_TONE: Record<IssuerDisclosureState, string> = {
  published: "text-foreground",
  gap: SEVERITY_TONE_CLASS.watch.text,
  unrecorded: "text-muted-foreground",
};

function StatusBadge({ label, toneClass, title }: { label: string; toneClass: string; title?: string }) {
  return (
    <Badge variant="outline" title={title} className={cn("max-w-full shrink-0 text-[11px] font-medium", toneClass)}>
      {label}
    </Badge>
  );
}

/**
 * One row per regime that applies: the regime and its jurisdiction code, then
 * the status pill with the issuer pathway (GENIUS) or token type (MiCA)
 * beside it. Status and caption sit next to the regime they qualify, so the
 * association survives any container width.
 */
function RegimeList({ regimes }: { regimes: readonly RegulatoryRegimeView[] }) {
  return (
    <dl className="divide-y divide-border/40">
      {regimes.map((regime) => (
        <div
          key={regime.key}
          className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-x-3 py-2.5 first:pt-0"
        >
          <dt>
            <span aria-hidden="true" className="block text-xs font-semibold leading-5 text-foreground">
              {regime.shortLabel}
            </span>
            <span aria-hidden="true" className="block font-mono text-[11px] leading-tight text-muted-foreground">
              {regime.jurisdiction}
            </span>
            <span className="sr-only">{regime.regimeLabel}</span>
          </dt>
          <dd className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <StatusBadge
              label={regime.status.label}
              toneClass={regime.status.toneClass}
              title={regime.status.description}
            />
            {regime.caption ? (
              <span className="text-xs leading-snug text-muted-foreground">{regime.caption}</span>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** ✓ for published, – otherwise; the value word always follows, so no legend is needed. */
function DisclosureValue({ row }: { row: IssuerDisclosureRow }) {
  const glyph =
    row.state === "published" ? (
      <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
    ) : (
      <span aria-hidden="true" className="w-3.5 shrink-0 text-center leading-none">
        –
      </span>
    );

  if (row.state === "published" && row.href) {
    return (
      <a
        href={row.href}
        target="_blank"
        rel="noopener noreferrer"
        title={row.title ?? `${row.label}: open the disclosure`}
        className="pharos-focus-ring -my-1 inline-flex min-h-6 items-center gap-1 rounded-sm text-foreground underline decoration-dotted underline-offset-4 transition-colors hover:decoration-solid motion-reduce:transition-none"
      >
        {glyph}
        {row.value}
        <span className="sr-only">, open the disclosure</span>
      </a>
    );
  }
  return (
    <span title={row.title} className={cn("inline-flex items-center gap-1", DISCLOSURE_STATE_TONE[row.state])}>
      {glyph}
      {row.value}
      {row.title ? <span className="sr-only">. {row.title}</span> : null}
    </span>
  );
}

/**
 * What the issuer publishes: the GENIUS review's findings, with the
 * attestation read from the reserves record the passport also shows. Its own
 * labelled row, never cells of a regime: a published attestation says nothing
 * about authorization under either regime. Absent without a GENIUS review;
 * a review that recorded none of the three reads as one line.
 */
function IssuerDisclosures({ rows }: { rows: readonly IssuerDisclosureRow[] }) {
  if (rows.length === 0) return null;
  const label = <span className="text-xs font-medium text-foreground">Issuer disclosures</span>;

  if (rows.every((row) => row.state === "unrecorded")) {
    return (
      <p className="flex items-baseline justify-between gap-3 border-t border-border/40 pt-2.5 text-xs">
        {label}
        <span className="sr-only">: </span>
        <span className="text-muted-foreground">{rows[0]?.value}</span>
      </p>
    );
  }
  return (
    <div className="border-t border-border/40 pt-2.5">
      <p>{label}</p>
      <dl className="mt-2 grid grid-cols-3 gap-x-3">
        {rows.map((row) => (
          <div key={row.key} className="min-w-0">
            <dt title={row.label} className="truncate text-[11px] leading-4 text-muted-foreground">
              <span aria-hidden="true">{row.shortLabel}</span>
              <span className="sr-only">{row.label}</span>
            </dt>
            <dd className="mt-1 text-xs leading-5">
              <DisclosureValue row={row} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Standing({ view }: { view: RegulatoryStandingView }) {
  return (
    <>
      <RegimeList regimes={view.regimes} />
      <IssuerDisclosures rows={view.issuerDisclosures} />
    </>
  );
}

/** Regulator facts, the latest report dates and the reviewer narrative: the fold's notes. */
function buildFoldNotes(view: RegulatoryStandingView): { notes: ReactNode; count: number } {
  const facts: FactGridItem[] = view.regimes.flatMap((regime) =>
    regime.facts.map((fact) => ({
      ...fact,
      key: `${regime.key}-${fact.key}`,
      label: `${regime.jurisdiction} ${fact.label.toLowerCase()}`,
    })),
  );
  const count = facts.length + (view.reportNote ? 1 : 0) + (view.notes ? 1 : 0);
  const notes =
    count > 0 ? (
      <>
        {facts.length > 0 ? <FactGrid aria-label="Regulator facts" items={facts} /> : null}
        {view.reportNote ? <p>{view.reportNote}</p> : null}
        {view.notes ? (
          <div className="space-y-1">
            <p className="font-medium text-foreground">GENIUS review notes</p>
            <p>{view.notes}</p>
          </div>
        ) : null}
      </>
    ) : null;
  return { notes, count };
}

export type RegulatoryStandingDensity = "rail" | "main";

/**
 * Regulatory standing (plan §5, §7, decision S2): one row per regime that
 * applies (GENIUS / US, MiCA / EU: status and pathway or token type), the
 * issuer disclosures as their own labelled row, a one-line verdict, one
 * provenance fold (regulator facts, latest report dates, review notes,
 * sources) and the review date.
 *
 * Mounted twice, at two densities:
 * - `rail` (the `xl+` rail copy, `anchorTwin`): `RailCard` shell, "Details &
 *   sources (N)" fold, the review date as the card's last line.
 * - `main` (the in-flow twin below `xl`, owning `id`): an `EvidenceModule`
 *   tile with the module header (logo · SYMBOL · title, status right), the
 *   standing capped at ~36rem with the verdict beside it on wide containers,
 *   and the `EvidenceFooter` fold and right-aligned `Reviewed <ISO date>`.
 *
 * Density defaults by usage: `main` when the copy owns `id` and is not an
 * anchor twin, `rail` otherwise. Renders nothing without a view; the caller
 * owns any "Not reviewed" state.
 */
export function RegulatoryStandingCard({
  view,
  id,
  anchorTwin = false,
  density,
  stripForm = false,
  className,
}: {
  view: RegulatoryStandingView | null;
  /** Anchor id when this copy owns it (the in-flow twin): `jurisdiction`. */
  id?: string;
  /** Marks this copy as the stand-in for the anchor its in-flow twin owns. */
  anchorTwin?: boolean;
  density?: RegulatoryStandingDensity;
  /** `main` only: the strip layout for a lone last tile. */
  stripForm?: boolean;
  /** `main` only: lands on the module `<section>` (grid placement, visibility). */
  className?: string;
}) {
  if (!view) return null;

  const fold = buildFoldNotes(view);

  const resolvedDensity = density ?? (id && !anchorTwin ? "main" : "rail");
  const badge = <StatusBadge label={view.badgeLabel} toneClass={view.badgeToneClass} />;

  if (resolvedDensity === "main") {
    return (
      <EvidenceModule
        id={anchorTwin ? undefined : id}
        title={TITLE}
        variant="tile"
        stripForm={stripForm}
        headerRight={badge}
        className={className}
        visual={
          <div className="@container/regulatory">
            <div className="grid gap-x-10 gap-y-4 @3xl/regulatory:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <div className="min-w-0 max-w-xl">
                <Standing view={view} />
              </div>
              <p className="max-w-prose text-sm leading-relaxed text-pretty text-foreground">{view.summary}</p>
            </div>
          </div>
        }
        footer={
          <EvidenceFooter
            notes={fold.notes ?? undefined}
            notesCount={fold.count}
            sources={view.sources}
            reviewed={view.reviewedAt ?? undefined}
          />
        }
      />
    );
  }

  const foldCount = fold.count + view.sources.length;
  return (
    <RailCard
      id={anchorTwin ? undefined : id}
      anchorTwin={anchorTwin ? (id ?? JURISDICTION_ANCHOR_ID) : undefined}
      title={TITLE}
      ariaLabel={TITLE}
      trailing={badge}
    >
      <div className="px-4 pb-4">
        <Standing view={view} />
        <p className="mt-3 text-sm leading-snug text-foreground">{view.summary}</p>
        {foldCount > 0 ? (
          <ModuleDisclosure label="Details & sources" count={foldCount} className="mt-3" summaryClassName="text-xs">
            <div className="mt-1 space-y-3 pb-1 text-xs leading-relaxed text-muted-foreground">
              {fold.notes}
              {view.sources.length > 0 ? (
                <SourceLinkList aria-label="Sources" sources={view.sources} className="space-y-2" />
              ) : null}
            </div>
          </ModuleDisclosure>
        ) : null}
        {view.reviewedAt ? (
          <p className="mt-3 border-t border-border/50 pt-3 text-xs text-muted-foreground">
            Reviewed {view.reviewedAt}
          </p>
        ) : null}
      </div>
    </RailCard>
  );
}
