import type { LucideIcon } from "lucide-react";
import { ArrowDownUp, ExternalLink, ShieldOff } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell } from "@/components/table";
import { formatAddress } from "@shared/lib/format";

type EventFeedVariant = "flow" | "blacklist";

const SKELETON_VARIANTS: Record<
  EventFeedVariant,
  {
    badge: string;
    detail: string;
    trailing: string;
  }
> = {
  flow: {
    badge: "h-5 w-12 rounded-full",
    detail: "h-4 w-20",
    trailing: "h-4 w-20",
  },
  blacklist: {
    badge: "h-5 w-16 rounded-full",
    detail: "h-4 w-24",
    trailing: "h-4 w-4 shrink-0",
  },
};

const EMPTY_VARIANTS: Record<
  EventFeedVariant,
  {
    icon: LucideIcon;
    className: string;
    message: string;
  }
> = {
  flow: {
    icon: ArrowDownUp,
    className: "flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground",
    message: "No mint/burn events recorded yet.",
  },
  blacklist: {
    icon: ShieldOff,
    className: "flex flex-col items-center justify-center gap-3 py-12 text-muted-foreground",
    message: "No blacklist events recorded yet.",
  },
};

export function EventFeedSkeleton({ variant }: { variant: EventFeedVariant }) {
  const widths = SKELETON_VARIANTS[variant];
  return (
    <div className="rounded-xl border overflow-hidden">
      <div className="bg-muted/50 h-10" />
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-2 border-t">
          <Skeleton className="h-4 w-16" />
          <Skeleton className={widths.badge} />
          <Skeleton className={widths.detail} />
          <Skeleton className="h-4 w-16" />
          <div className="flex-1" />
          <Skeleton className={widths.trailing} />
          {variant === "flow" ? <Skeleton className="h-4 w-4 shrink-0" /> : null}
        </div>
      ))}
    </div>
  );
}

export function EventFeedEmpty({ variant }: { variant: EventFeedVariant }) {
  const empty = EMPTY_VARIANTS[variant];
  const Icon = empty.icon;
  return (
    <div className={empty.className}>
      <Icon className="h-10 w-10 opacity-40" />
      <p className="text-sm">{empty.message}</p>
    </div>
  );
}

export function EventTransactionCell({ txHash, href }: { txHash: string; href: string }) {
  return (
    <TableCell className="text-center">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
        aria-label="View transaction on block explorer"
      >
        <span className="hidden md:inline">{formatAddress(txHash)}</span>
        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
      </a>
    </TableCell>
  );
}
