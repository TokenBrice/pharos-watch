interface DepegProvenanceBadgesProps {
  pendingReason: string | null;
  confirmationSources: string | null;
  reasonLeadingClass?: string;
}

const BADGE_CLASS =
  "rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground";

export function DepegProvenanceBadges({
  pendingReason,
  confirmationSources,
  reasonLeadingClass = "",
}: DepegProvenanceBadgesProps) {
  if (!pendingReason && !confirmationSources) return null;
  return (
    <>
      {pendingReason ? (
        <span
          data-testid="event-pending-reason"
          className={`${reasonLeadingClass} ${BADGE_CLASS}`.trim()}
        >
          {pendingReason}
        </span>
      ) : null}
      {confirmationSources ? (
        <span
          data-testid="event-confirmed-by"
          className={`${pendingReason ? "ml-1 " : reasonLeadingClass + " "}${BADGE_CLASS}`.trim()}
        >
          ✓ {confirmationSources}
        </span>
      ) : null}
    </>
  );
}
