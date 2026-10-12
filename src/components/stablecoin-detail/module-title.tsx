"use client";

import type { ReactNode } from "react";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";

/**
 * A detail-page module title. Module headers carry no coin prefix by default:
 * the dossier header already names the coin, and repeating "USDT ·" on every
 * card was noise. A caller that is screenshotted out of context (the Safety
 * Score card) passes `symbol` explicitly to keep its subject in frame.
 */
export function StablecoinModuleTitle({
  children,
  as = "h2",
  className,
  id,
  symbol,
  logoSrc,
}: {
  children: ReactNode;
  as?: "h1" | "h2" | "h3" | "h4" | "div";
  className?: string;
  id?: string;
  symbol?: string | null;
  logoSrc?: string;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {symbol ? (
        <>
          <StablecoinLogo src={logoSrc} name={symbol} size={26} />
          <span className="shrink-0 text-sm font-semibold text-foreground">
            {symbol}
          </span>
          <span className="text-muted-foreground/50" aria-hidden="true">
            ·
          </span>
        </>
      ) : null}
      <DetailSectionTitle as={as} className={className} id={id}>
        {children}
      </DetailSectionTitle>
    </div>
  );
}
