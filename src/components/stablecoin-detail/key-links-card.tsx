"use client";

import { ExternalLink, Globe } from "lucide-react";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { RailCard } from "@/components/stablecoin-detail/rail-card";
import { SECTION_SCROLL_MT } from "@/components/stablecoin-detail/section-title-class";
import { cn } from "@/lib/utils";
import { getProofOfReservesStyle, POR_NEUTRAL_REPORT_LABEL } from "@shared/lib/classification";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";

const SHORT_PROVIDER_MAX_CHARS = 80;

/**
 * Splits long multi-clause Proof-of-Reserves provider notes so the 22rem rail
 * never expands to 6+ lines of prose. Short attestor names stay verbatim.
 */
function parseProviderSummary(provider: string | undefined): { lead: string | null; note: string | null } {
  if (!provider) return { lead: null, note: null };
  const trimmed = provider.trim();
  if (!trimmed) return { lead: null, note: null };
  if (trimmed.length <= SHORT_PROVIDER_MAX_CHARS && !/\.\s/.test(trimmed)) {
    return { lead: trimmed, note: null };
  }
  const clauseBreak = trimmed.search(/(?:;\s|\.\s|\s\()/);
  if (clauseBreak > 0 && clauseBreak <= SHORT_PROVIDER_MAX_CHARS) {
    return {
      lead: trimmed.slice(0, clauseBreak).trim(),
      note: trimmed,
    };
  }
  return { lead: null, note: trimmed };
}

const LINK_CLASS =
  "pharos-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground sm:min-h-0";
/**
 * Inline pills in a balanced block: the last row never holds a lone pill. The
 * row gap is each pill's top margin, cancelled once by the row, so the parent's
 * own spacing (a `space-y` bottom margin) is left untouched.
 */
const PILL_ROW_CLASS = "-mt-1.5 text-balance";
const PILL_IN_ROW_CLASS = "mt-1.5 mr-1.5 align-top";

/**
 * The coin's outbound links, in the rail-module grammar: the curated issuer
 * links (website, socials, docs) plus the reserve-attestation link, which needs
 * the attestor line beside it to mean anything.
 *
 * This is what survived the Key Information card: every other fact it carried
 * is rendered by the hero (launch date in the header; jurisdiction, MiCA and
 * attestor tier in the passport strip), the rail review modules (regulatory standing, custody,
 * collateralization), or Peg Stability (collateral and peg-mechanism prose).
 *
 * Mounted twice like every rail module — the `xl+` rail after News, and an
 * `xl:hidden` in-flow copy. `anchors` marks the in-flow copy as the owner of
 * `#attestation` (the passport's Attestor link); the rail copy stands in for it
 * through `anchorTwin` when the in-flow copy is display-hidden. The in-flow
 * copy spans the column, so it lays the links and the attestation out as one
 * wrapping row instead of the rail's stack.
 */
export function KeyLinksCard({ meta, anchors = false }: { meta: StablecoinMeta; anchors?: boolean }) {
  const links = meta.links ?? [];
  const proofOfReserves = meta.proofOfReserves ?? null;
  if (links.length === 0 && !proofOfReserves) return null;

  return (
    <RailCard title="Key links" ariaLabel="Key links" {...(anchors ? {} : { anchorTwin: "attestation" })}>
      <div className={anchors ? "flex flex-wrap items-center gap-x-6 gap-y-3 px-4 pb-4" : "space-y-4 px-4 pb-4"}>
        {links.length > 0 ? (
          <div className={PILL_ROW_CLASS}>
            {links.map((link) => (
              <a
                key={link.url}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(LINK_CLASS, PILL_IN_ROW_CLASS)}
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
        ) : null}
        {proofOfReserves ? (() => {
          const styleLabel = getProofOfReservesStyle(proofOfReserves)?.label ?? POR_NEUTRAL_REPORT_LABEL;
          const providerSummary = parseProviderSummary(proofOfReserves.provider);
          return (
            <div
              className={anchors ? cn("flex flex-wrap items-center gap-x-3 gap-y-1.5", SECTION_SCROLL_MT) : "space-y-1.5"}
              {...(anchors ? { id: "attestation" } : {})}
            >
              <p className="pharos-label">Proof of Reserves</p>
              <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground" title={providerSummary.note ?? undefined}>
                {styleLabel}
                {providerSummary.lead ? ` by ${providerSummary.lead}` : ""}
              </p>
              {providerSummary.note ? (
                <ModuleDisclosure label="Attestation notes" summaryClassName="min-h-8 text-xs lg:min-h-7">
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{providerSummary.note}</p>
                </ModuleDisclosure>
              ) : null}
              <a href={proofOfReserves.url} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
                View reserves
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
          );
        })() : null}
      </div>
    </RailCard>
  );
}
