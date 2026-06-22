import type { ReactNode } from "react";
import Link from "next/link";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { POR_TIER_STYLES } from "@shared/lib/classification";
import type { StablecoinMeta } from "@shared/types";

/** Base Tailwind classes shared by every badge pill in this card. Color and
 *  interactive modifiers are appended at each call site as static literals. */
const BADGE_PILL_BASE = "inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold";

/** Plain span badge pill -- wraps BADGE_PILL_BASE + a color cls. */
export function BadgePill({ cls, children }: { cls: string; children: ReactNode }) {
  return <span className={`${BADGE_PILL_BASE} ${cls}`}>{children}</span>;
}

export function ClassificationBadgeLink({
  href,
  cls,
  ariaLabel,
  title,
  children,
}: {
  href: string;
  cls: string;
  ariaLabel: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      title={title}
      aria-label={ariaLabel}
      className={`pharos-focus-ring ${BADGE_PILL_BASE} transition-colors hover:brightness-110 ${cls}`}
    >
      {children}
    </Link>
  );
}

export function AttestorTierBadge({
  proofOfReserves,
}: {
  proofOfReserves: NonNullable<StablecoinMeta["proofOfReserves"]>;
}) {
  if (!proofOfReserves.attestorTier) return null;

  const tierStyle = POR_TIER_STYLES[proofOfReserves.attestorTier];
  const pillClass = `${BADGE_PILL_BASE} ${tierStyle.cls}`;
  const pillText = `${tierStyle.label}${proofOfReserves.provider ? ` · ${proofOfReserves.provider}` : ""}`;
  const details: Array<{ label: string; value: string }> = [];

  if (proofOfReserves.provider) details.push({ label: "Provider", value: proofOfReserves.provider });
  if (proofOfReserves.cadence) details.push({ label: "Cadence", value: proofOfReserves.cadence });
  if (proofOfReserves.attestorJurisdiction) {
    details.push({ label: "Jurisdiction", value: proofOfReserves.attestorJurisdiction });
  }
  if (proofOfReserves.attestorLicense) {
    details.push({ label: "License", value: proofOfReserves.attestorLicense });
  }

  if (details.length === 0) {
    return <span className={pillClass}>{pillText}</span>;
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`pharos-focus-ring ${pillClass}`}
          aria-label={`Show attestor details for ${tierStyle.label}`}
        >
          {pillText}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto max-w-[280px] border-border/70 p-3 text-sm">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
          {details.map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{row.label}</dt>
              <dd className="text-sm leading-snug">{row.value}</dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
}
