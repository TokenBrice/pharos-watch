"use client";

import { createContext, useContext, type ReactNode } from "react";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";

interface StablecoinDetailIdentity {
  symbol: string;
  logoSrc: string | undefined;
}

const StablecoinDetailIdentityContext = createContext<StablecoinDetailIdentity | null>(null);

export function StablecoinDetailIdentityProvider({
  children,
  symbol,
  logoSrc,
}: StablecoinDetailIdentity & { children: ReactNode }) {
  return (
    <StablecoinDetailIdentityContext.Provider value={{ symbol, logoSrc }}>
      {children}
    </StablecoinDetailIdentityContext.Provider>
  );
}

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
  const contextIdentity = useContext(StablecoinDetailIdentityContext);
  const resolvedSymbol = symbol ?? contextIdentity?.symbol;
  const resolvedLogoSrc = logoSrc ?? contextIdentity?.logoSrc;

  return (
    <div className="flex min-w-0 items-center gap-2">
      {resolvedSymbol ? (
        <>
          <StablecoinLogo src={resolvedLogoSrc} name={resolvedSymbol} size={26} />
          <span className="truncate text-sm font-semibold text-foreground">
            {resolvedSymbol}
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
