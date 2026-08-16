import Link from "next/link";
import { formatCurrency } from "@shared/lib/format";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import type { CoverageRow } from "@/lib/coverage";
import { buildStablecoinUrl } from "@shared/lib/urls";

interface CoverageCoinIdentityProps {
  row: CoverageRow;
  logoSrc?: string;
  logoSize: number;
  linked?: boolean;
  variant?: "mobile" | "table";
}

function IdentityContent({
  row,
  logoSrc,
  logoSize,
  variant = "table",
}: Omit<CoverageCoinIdentityProps, "linked">) {
  const isMobile = variant === "mobile";

  return (
    <>
      <StablecoinLogo src={logoSrc} name={row.name} size={logoSize} />
      <div className="min-w-0">
        <div className={isMobile ? "flex flex-wrap items-center gap-x-2 gap-y-1" : "flex min-w-0 items-center gap-2"}>
          <span className={`${isMobile ? "text-sm font-semibold" : "text-sm font-medium"} shrink-0 text-foreground`}>
            {row.symbol}
          </span>
          <span className={`${isMobile ? "text-sm" : "text-xs xl:text-sm"} min-w-0 truncate text-muted-foreground`}>
            {row.name}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
          <span className="pharos-numeric text-foreground">
            {row.marketCapUsd > 0 ? formatCurrency(row.marketCapUsd) : "Mcap -"}
          </span>
          <span aria-hidden>&middot;</span>
          <span>{row.pegLabel}</span>
          <span aria-hidden>&middot;</span>
          <span>{row.backingLabel}</span>
          <span aria-hidden>&middot;</span>
          <span>{row.governanceLabel}</span>
        </div>
      </div>
    </>
  );
}

export function CoverageCoinIdentity({
  row,
  logoSrc,
  logoSize,
  linked = false,
  variant = "table",
}: CoverageCoinIdentityProps) {
  const className = variant === "mobile"
    ? "flex min-w-0 items-start gap-3"
    : "pharos-focus-ring inline-flex w-full min-w-0 items-center gap-2 rounded-lg";

  if (linked) {
    return (
      <Link href={buildStablecoinUrl(row.id)} className={className}>
        <IdentityContent row={row} logoSrc={logoSrc} logoSize={logoSize} variant={variant} />
      </Link>
    );
  }

  return (
    <div className={className}>
      <IdentityContent row={row} logoSrc={logoSrc} logoSize={logoSize} variant={variant} />
    </div>
  );
}
