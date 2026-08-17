"use client";

import { ExternalLink, Globe } from "lucide-react";
import { RailCard } from "@/components/stablecoin-detail/rail-card";
import { SECTION_SCROLL_MT } from "@/components/stablecoin-detail/section-title-class";
import { cn } from "@/lib/utils";
import { POR_BADGE_STYLES } from "@shared/lib/classification";
import type { StablecoinMeta } from "@shared/types";

const LINK_CLASS =
  "pharos-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground sm:min-h-0";

/**
 * The coin's outbound links, in the rail-module grammar: the curated issuer
 * links (website, socials, docs) plus the reserve-attestation link, which needs
 * the attestor line beside it to mean anything.
 *
 * This is what survived the Key Information card: every other fact it carried
 * is rendered by the hero passport strip (jurisdiction, MiCA, attestor tier,
 * launch date), the rail review modules (regulatory standing, custody,
 * collateralization), or Peg Stability (collateral and peg-mechanism prose).
 *
 * Mounted twice like every rail module — the `xl+` rail after News, and an
 * `xl:hidden` in-flow copy. `anchors` marks the in-flow copy as the owner of
 * `#attestation` (the passport's Attestor link); the rail copy stands in for it
 * through `anchorTwin` when the in-flow copy is display-hidden.
 */
export function KeyLinksCard({ meta, anchors = false }: { meta: StablecoinMeta; anchors?: boolean }) {
  const links = meta.links ?? [];
  const proofOfReserves = meta.proofOfReserves ?? null;
  if (links.length === 0 && !proofOfReserves) return null;

  return (
    <RailCard title="Key Links" ariaLabel="Key links" {...(anchors ? {} : { anchorTwin: "attestation" })}>
      <div className="space-y-4 px-4 pb-4">
        {links.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {links.map((link) => (
              <a
                key={link.url}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className={LINK_CLASS}
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
        {proofOfReserves ? (
          <div
            className={cn("space-y-1.5", anchors ? SECTION_SCROLL_MT : undefined)}
            {...(anchors ? { id: "attestation" } : {})}
          >
            <p className="pharos-kicker">Proof of Reserves</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {POR_BADGE_STYLES[proofOfReserves.type].label}
              {proofOfReserves.provider ? ` by ${proofOfReserves.provider}` : ""}
            </p>
            <a href={proofOfReserves.url} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
              View reserves
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        ) : null}
      </div>
    </RailCard>
  );
}
