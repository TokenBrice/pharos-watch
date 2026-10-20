"use client";

import { createContext, useContext, type ReactNode } from "react";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  DETAIL_MODULE_BODY_CLASS,
  DETAIL_MODULE_HEADER_CLASS,
  DETAIL_MODULE_SHELL_CLASS,
  DETAIL_MODULE_TITLE_CLASS,
} from "@/components/stablecoin-detail/section-title-class";
import { cn } from "@/lib/utils";

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

/**
 * A detail-page module title. Every dossier module carries the coin logo and
 * symbol: modules are screenshotted and shared out of context, so each card
 * must name its subject. Identity comes from the page-level provider unless a
 * caller passes `symbol` explicitly.
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
  const contextIdentity = useContext(StablecoinDetailIdentityContext);
  const resolvedSymbol = symbol ?? contextIdentity?.symbol;
  const resolvedLogoSrc = logoSrc ?? contextIdentity?.logoSrc;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {resolvedSymbol ? (
        <>
          <StablecoinLogo src={resolvedLogoSrc} name={resolvedSymbol} size={26} />
          <span className="shrink-0 text-sm font-semibold text-foreground">
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

/** Plain main-column shell; caller-owned sections and query branches stay outside. */
export function DetailModuleCard({ title, headerRight, id, className, bodyClassName, children }: {
  title: ReactNode;
  headerRight?: ReactNode;
  id?: string;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <Card className={cn(DETAIL_MODULE_SHELL_CLASS, className)} id={id}>
      <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
        <StablecoinModuleTitle className={DETAIL_MODULE_TITLE_CLASS}>{title}</StablecoinModuleTitle>
        {headerRight}
      </CardHeader>
      <CardContent className={cn(DETAIL_MODULE_BODY_CLASS, bodyClassName)}>{children}</CardContent>
    </Card>
  );
}
