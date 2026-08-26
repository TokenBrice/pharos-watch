import Link from "next/link";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { TableSourceLink } from "@/components/table/client";
import { cn } from "@/lib/utils";
import { buildStablecoinUrl } from "@shared/lib/urls";
import {
  GENIUS_AUTHORIZATION_STATUS_BADGE_STYLES,
  GENIUS_AUTHORIZATION_STATUS_DESCRIPTIONS,
} from "@shared/lib/genius";
import {
  MICA_STATUS_BADGE_STYLES,
  MICA_STATUS_DESCRIPTIONS,
} from "@shared/lib/mica";
import type { GeniusAuthorizationStatus, MicaStatus } from "@shared/types";
import type { ComplianceOverviewRow } from "@/lib/compliance-model";

export function CoinLink({
  row,
  logo,
}: {
  row: Pick<ComplianceOverviewRow, "id" | "name" | "symbol">;
  logo: string | undefined;
}) {
  return (
    <Link
      href={buildStablecoinUrl(row.id)}
      className="pharos-focus-ring inline-flex min-w-0 max-w-full items-center gap-2 rounded-sm hover:text-foreground"
    >
      <StablecoinLogo src={logo} name={row.name} size={28} />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{row.symbol}</span>
        <span className="block truncate text-xs text-muted-foreground">{row.name}</span>
      </span>
    </Link>
  );
}

export function ComplianceStatusBadge({
  regime,
  status,
}: {
  regime: "mica" | "genius";
  status: MicaStatus | GeniusAuthorizationStatus;
}) {
  const badge = regime === "mica"
    ? MICA_STATUS_BADGE_STYLES[status as MicaStatus]
    : GENIUS_AUTHORIZATION_STATUS_BADGE_STYLES[status as GeniusAuthorizationStatus];
  const description = regime === "mica"
    ? MICA_STATUS_DESCRIPTIONS[status as MicaStatus]
    : GENIUS_AUTHORIZATION_STATUS_DESCRIPTIONS[status as GeniusAuthorizationStatus];
  return (
    <span
      title={description}
      className={cn("inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold", badge.cls)}
    >
      {badge.label}
    </span>
  );
}

export function SourceLinks({ references }: { references: readonly { label: string; url: string }[] }) {
  if (references.length === 0) return <EmptyCell />;
  return (
    <div className="flex min-w-0 flex-col items-start gap-1 overflow-hidden">
      {references.map((reference) => (
        <TableSourceLink
          key={`${reference.label}:${reference.url}`}
          href={reference.url}
          title={reference.label}
          className="pharos-focus-ring inline-flex max-w-full items-center gap-1 rounded-sm text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          iconClassName="h-3 w-3"
        >
          {reference.label}
        </TableSourceLink>
      ))}
    </div>
  );
}

export function EmptyCell() {
  return <span className="text-xs text-muted-foreground">-</span>;
}
