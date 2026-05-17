import type { ReactNode } from "react";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { cn } from "@/lib/utils";

interface StablecoinIdentityProps {
  logoSrc?: string;
  name: string;
  symbol: string;
  logoSize?: number;
  badge?: ReactNode;
  details?: ReactNode;
  layout?: "flex" | "contents";
  className?: string;
  textClassName?: string;
  symbolRowClassName?: string;
  symbolClassName?: string;
  nameClassName?: string;
}

export function StablecoinIdentity({
  logoSrc,
  name,
  symbol,
  logoSize = 24,
  badge,
  details,
  layout = "flex",
  className,
  textClassName,
  symbolRowClassName,
  symbolClassName,
  nameClassName,
}: StablecoinIdentityProps) {
  return (
    <span className={layout === "contents" ? cn("contents", className) : cn("flex items-center gap-2", className)}>
      <StablecoinLogo src={logoSrc} name={name} size={logoSize} />
      <span className={cn("min-w-0", textClassName)}>
        <span className={cn("flex items-center gap-2", symbolRowClassName)}>
          <span className={cn("font-medium", symbolClassName)}>{symbol}</span>
          {badge}
        </span>
        {details}
        {nameClassName ? (
          <span className={nameClassName}>{name}</span>
        ) : null}
      </span>
    </span>
  );
}
