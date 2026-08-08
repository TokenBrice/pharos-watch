"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowUpRight, ChevronDown, ExternalLink, Globe } from "lucide-react";
import {
  SECTION_DIVIDER_CLASS,
  SECTION_SCROLL_MT,
} from "@/components/stablecoin-detail/section-title-class";
import { mechanismDiagramFor } from "@/components/stablecoin-detail/mechanism-diagrams";
import { getCoinOverride } from "@/components/stablecoin-detail/mechanism-diagrams/coin-overrides";
import type { MechanismDiagramOptions } from "@/components/stablecoin-detail/mechanism-diagrams/types";
import { cn } from "@/lib/utils";
import { buildPegLandingUrl } from "@/lib/peg-landing";
import { formatLaunchDate } from "@/lib/stablecoin-detail-passport";
import {
  buildBackingTaxonomyUrl,
  buildGovernanceTaxonomyUrl,
  buildInfrastructureTaxonomyUrl,
} from "@/lib/stablecoin-taxonomy-urls";
import {
  BACKING_BADGE_STYLES,
  BACKING_LABELS,
  GOVERNANCE_BADGE_STYLES,
  GOVERNANCE_LABELS,
  PEG_BADGE_STYLES,
  PEG_LABELS,
  POR_BADGE_STYLES,
  getMechanismArchetypeCtaNoun,
  getMechanismExplainerPath,
} from "@shared/lib/classification";
import { getInfrastructureLabel, getInfrastructureSummary } from "@shared/lib/infrastructure";
import { MICA_STATUS_BADGE_STYLES, MICA_STATUS_DESCRIPTIONS } from "@shared/lib/mica";
import type { MechanismArchetype, StablecoinMeta, VariantKind } from "@shared/types";
import { AttestorTierBadge, BadgePill, ClassificationBadgeLink } from "./badges";

export function getKeyInfoSentenceLabels(meta: StablecoinMeta) {
  return {
    governanceFullLabel: GOVERNANCE_LABELS[meta.flags.governance] ?? meta.flags.governance,
    backingFullLabel: BACKING_LABELS[meta.flags.backing] ?? meta.flags.backing,
    pegFullLabel: PEG_LABELS[meta.flags.pegCurrency] ?? meta.flags.pegCurrency,
  };
}

export function ClassificationAndLinks({ meta }: { meta: StablecoinMeta }) {
  const gov = GOVERNANCE_BADGE_STYLES[meta.flags.governance];
  const backing = BACKING_BADGE_STYLES[meta.flags.backing];
  const peg = PEG_BADGE_STYLES[meta.flags.pegCurrency];
  const governanceHref = buildGovernanceTaxonomyUrl(meta.flags.governance);
  const backingHref = buildBackingTaxonomyUrl(meta.flags.backing);
  const pegHref = buildPegLandingUrl(meta.flags.pegCurrency);
  const { governanceFullLabel, backingFullLabel, pegFullLabel } = getKeyInfoSentenceLabels(meta);
  const infrastructureSummaries = buildInfrastructureSummaries(meta);
  const isDecentralized = meta.flags.governance === "decentralized";
  const hasLinks = meta.links && meta.links.length > 0;

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {gov && (
          <ClassificationBadgeLink
            href={governanceHref}
            ariaLabel={`Browse ${governanceFullLabel} stablecoins`}
            cls={gov.cls}
          >
            {gov.label}
          </ClassificationBadgeLink>
        )}
        {backing && (
          <ClassificationBadgeLink
            href={backingHref}
            ariaLabel={`Browse ${backingFullLabel} stablecoins`}
            cls={backing.cls}
          >
            {backing.label}
          </ClassificationBadgeLink>
        )}
        {peg &&
          (pegHref ? (
            <ClassificationBadgeLink href={pegHref} ariaLabel={`Browse ${pegFullLabel} stablecoins`} cls={peg.cls}>
              {peg.label}
            </ClassificationBadgeLink>
          ) : (
            <BadgePill cls={peg.cls}>{peg.label}</BadgePill>
          ))}
        {infrastructureSummaries.map(({ value, label, href }) => (
          <Link
            key={value}
            href={href}
            aria-label={`Browse ${label} infrastructure stablecoins`}
            className="pharos-focus-ring inline-flex items-center rounded-full border border-border/60 bg-muted/40 px-3 py-1 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
          >
            {label}
          </Link>
        ))}
        {meta.flags.yieldBearing && (
          <BadgePill cls="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20">
            Yield-Bearing
          </BadgePill>
        )}
        {meta.flags.rwa && (
          <BadgePill cls="bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/20">RWA</BadgePill>
        )}
        {!isDecentralized &&
          (meta.proofOfReserves ? (
            meta.proofOfReserves.attestorTier ? (
              <AttestorTierBadge proofOfReserves={meta.proofOfReserves} />
            ) : (
              <BadgePill cls={POR_BADGE_STYLES[meta.proofOfReserves.type].cls}>
                {POR_BADGE_STYLES[meta.proofOfReserves.type].label}
              </BadgePill>
            )
          ) : (
            <BadgePill cls="bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20">No PoR</BadgePill>
          ))}
      </div>
      {hasLinks && (
        <div className="flex flex-wrap items-center gap-1.5">
          {meta.links?.map((link) => (
            <a
              key={link.url}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="pharos-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground"
            >
              {link.label === "Website" ? (
                <Globe className="h-3.5 w-3.5" />
              ) : (
                <ExternalLink className="h-3.5 w-3.5" />
              )}
              {link.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export function CollateralSection({ meta }: { meta: StablecoinMeta }) {
  if (!meta.collateral) return null;
  return (
    <div className={cn(SECTION_DIVIDER_CLASS)}>
      <p className="pharos-kicker mb-1.5">Collateral</p>
      <p className="text-base leading-relaxed">{meta.collateral}</p>
    </div>
  );
}

export interface PegStabilityBodyProps {
  meta: StablecoinMeta;
  resolvedMechanismArchetype?: MechanismArchetype | null;
  isWrapper: boolean;
  parentSymbol?: string | null;
  parentArchetype?: MechanismArchetype | null;
  variantKind?: VariantKind | null;
}

/** Diagram + explainer link + peg-mechanism prose, shared by the inline
 *  Key Info section and the standalone Peg Stability card (Figma coin
 *  template's split Risk-zone row). */
export function PegStabilityBody({
  meta,
  resolvedMechanismArchetype,
  isWrapper,
  parentSymbol,
  parentArchetype,
  variantKind,
}: PegStabilityBodyProps) {
  if (!meta.pegMechanism) return null;

  const effectiveArchetype =
    resolvedMechanismArchetype !== undefined ? resolvedMechanismArchetype : (meta.mechanismArchetype ?? null);
  const diagramOptions: MechanismDiagramOptions = {
    override: getCoinOverride(meta.id),
    ...(isWrapper && parentArchetype
      ? {
          isWrapper: true,
          parentSymbol: parentSymbol ?? undefined,
          parentArchetype,
          variantKind: variantKind ?? undefined,
        }
      : {}),
  };

  return (
    <div>
      {effectiveArchetype ? (
        <div className="mb-3 space-y-2">
          <div className="flex justify-start">{mechanismDiagramFor(effectiveArchetype, meta.symbol, diagramOptions)}</div>
          <Link
            href={getMechanismExplainerPath(effectiveArchetype)}
            className="pharos-focus-ring inline-flex min-h-11 items-center gap-1 py-2 text-xs font-medium text-frost-blue hover:underline sm:min-h-0 sm:py-0"
          >
            Learn how {getMechanismArchetypeCtaNoun(effectiveArchetype)} stablecoins work
            <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        </div>
      ) : (
        <div className="mb-3 rounded-lg border border-border/50 bg-muted/20 px-4 py-3 space-y-1.5">
          <p className="text-sm font-semibold">Custom design — no archetype assigned</p>
          <p className="text-sm text-muted-foreground leading-relaxed">
            This coin doesn&apos;t fit the six tracked archetypes. See the description below and the{" "}
            <Link href="/methodology/" className="pharos-focus-ring text-frost-blue hover:underline">
              methodology page
            </Link>{" "}
            for how Pharos scores it.
          </p>
        </div>
      )}
      <p className="text-base leading-relaxed">{meta.pegMechanism}</p>
    </div>
  );
}

export function MechanismSection({
  meta,
  resolvedMechanismArchetype,
  isWrapper,
  parentSymbol,
  parentArchetype,
  variantKind,
}: PegStabilityBodyProps) {
  const hasDescription = meta.collateral || meta.pegMechanism;
  if (!hasDescription) return null;

  return (
    <div id="mechanism" className={cn("grid gap-x-6 gap-y-3 sm:grid-cols-2", SECTION_SCROLL_MT, SECTION_DIVIDER_CLASS)}>
      {meta.collateral && (
        <div>
          <p className="pharos-kicker mb-1.5">Collateral</p>
          <p className="text-base leading-relaxed">{meta.collateral}</p>
        </div>
      )}
      {meta.pegMechanism && (
        <div>
          <p className="pharos-kicker mb-1.5">Peg Stability</p>
          <PegStabilityBody
            meta={meta}
            resolvedMechanismArchetype={resolvedMechanismArchetype}
            isWrapper={isWrapper}
            parentSymbol={parentSymbol}
            parentArchetype={parentArchetype}
            variantKind={variantKind}
          />
        </div>
      )}
    </div>
  );
}

/** One clamped line comfortably carries ~90 characters at the card width;
 *  shorter summaries skip the toggle so it never appears as a no-op. */
const INFRA_SUMMARY_CLAMP_THRESHOLD = 90;

function InfrastructureSummary({ summary }: { summary: string }) {
  const [open, setOpen] = useState(false);
  const collapsible = summary.length > INFRA_SUMMARY_CLAMP_THRESHOLD;

  return (
    <>
      <p className={cn("text-sm leading-relaxed text-muted-foreground", collapsible && !open && "line-clamp-1")}>
        {summary}
      </p>
      {collapsible ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="pharos-focus-ring inline-flex min-h-7 items-center gap-1 rounded-sm text-[11px] font-medium text-frost-blue"
        >
          {open ? "Show less" : "More"}
          <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} aria-hidden="true" />
        </button>
      ) : null}
    </>
  );
}

export function InfrastructureSection({ meta }: { meta: StablecoinMeta }) {
  const infrastructureSummaries = buildInfrastructureSummaries(meta);
  if (infrastructureSummaries.length === 0) return null;

  return (
    <div className={cn(SECTION_DIVIDER_CLASS, "space-y-3")}>
      <p className="pharos-kicker mb-1.5">Infrastructure</p>
      {infrastructureSummaries.map(({ value, label, summary, href }) => (
        <div key={value}>
          <Link
            href={href}
            className="pharos-focus-ring rounded-sm text-xs font-semibold text-foreground hover:text-frost-blue"
          >
            {label}
          </Link>
          <InfrastructureSummary summary={summary} />
        </div>
      ))}
    </div>
  );
}

export function ProofAndJurisdictionSection({ meta }: { meta: StablecoinMeta }) {
  if (meta.flags.governance === "decentralized") return null;

  const micaStatus = meta.mica ? MICA_STATUS_BADGE_STYLES[meta.mica.status] : null;
  const micaBadgePrefix = meta.status === "frozen" ? "Historical MiCA" : "MiCA";

  return (
    <div className={cn("grid gap-x-6 gap-y-3 sm:grid-cols-2", SECTION_DIVIDER_CLASS)}>
      <div id="attestation" className={SECTION_SCROLL_MT}>
        <p className="pharos-kicker mb-1.5">Proof of Reserves</p>
        {meta.proofOfReserves ? (
          <>
            <p className="text-sm leading-relaxed">
              {POR_BADGE_STYLES[meta.proofOfReserves.type].label}
              {meta.proofOfReserves.provider && ` by ${meta.proofOfReserves.provider}`}
            </p>
            {/* Bordered button per the Figma coin template, not an inline text link. */}
            <a
              href={meta.proofOfReserves.url}
              target="_blank"
              rel="noopener noreferrer"
              className="pharos-focus-ring mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground sm:min-h-0"
            >
              View reserves
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No proof of reserves published</p>
        )}
      </div>

      <div id="jurisdiction" className={SECTION_SCROLL_MT}>
        <p className="pharos-kicker mb-1.5">Jurisdiction</p>
        {meta.jurisdiction || meta.mica ? (
          <div className="flex flex-wrap items-center gap-2">
            {meta.jurisdiction && <span className="text-sm font-medium">{meta.jurisdiction.country}</span>}
            {meta.jurisdiction?.regulator && (
              <BadgePill cls="bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20">
                {meta.jurisdiction.regulator}
              </BadgePill>
            )}
            {meta.jurisdiction?.license && (
              <BadgePill cls="bg-violet-500/10 text-violet-700 dark:text-violet-400 border-violet-500/20">
                {meta.jurisdiction.license}
              </BadgePill>
            )}
            {meta.mica && micaStatus && (
              <ClassificationBadgeLink
                href="/compliance/?regime=mica"
                title={`${MICA_STATUS_DESCRIPTIONS[meta.mica.status]}${
                  meta.status === "frozen" ? " Historical status retained for this frozen asset." : ""
                }`}
                ariaLabel={`${micaBadgePrefix} status: ${micaStatus.label} — view the Compliance Tracker`}
                cls={micaStatus.cls}
              >
                {micaBadgePrefix}: {micaStatus.label}
              </ClassificationBadgeLink>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Not disclosed</p>
        )}
      </div>
    </div>
  );
}

export function LaunchDateSection({ launchDate }: { launchDate: StablecoinMeta["launchDate"] }) {
  const launchDateDisplay = formatLaunchDate(launchDate);
  if (!launchDateDisplay) return null;

  return (
    <div className={SECTION_DIVIDER_CLASS}>
      <p className="pharos-kicker mb-1.5">Launched</p>
      <p className="text-sm font-medium">{launchDateDisplay}</p>
    </div>
  );
}

function buildInfrastructureSummaries(meta: StablecoinMeta) {
  return (meta.infrastructures ?? []).map((value) => ({
    value,
    label: getInfrastructureLabel(value),
    summary: getInfrastructureSummary(value),
    href: buildInfrastructureTaxonomyUrl(value),
  }));
}
