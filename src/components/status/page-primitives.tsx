import type { ChangeEvent, ReactNode } from "react";
import { CLIENT_ACTIVE_META_BY_ID as ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import {
  getNoticeTone,
  type DashboardNotice,
  type DashboardSectionId,
} from "@/lib/status-dashboard-model";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { DataTableColumn } from "@/components/data-table-shell";
import { cn } from "@/lib/utils";
import {
  OPERATOR_VERDICT_TONE,
  PUBLIC_COMPONENT_STATE_TONE,
  type OperatorVerdict,
} from "@shared/lib/classification";
import { formatElapsedSeconds, timeAgo } from "@shared/lib/format";
import type { PublicComponentState } from "@shared/types";

export function getCoinLabel(coinId: string): string {
  const meta = ACTIVE_META_BY_ID.get(coinId);
  if (!meta) return coinId;
  return `${meta.symbol} · ${meta.name}`;
}

export function defineStatusColumns(columns: readonly (readonly [string, string])[]): readonly DataTableColumn[] {
  return columns.map(([id, label]) => ({ id, label, className: "pb-2 font-medium" }));
}

/**
 * The muted inner-panel surface used inside status/admin cards — border plus
 * tint only. Radius and padding stay at the call site because they genuinely
 * vary by nesting depth (`rounded-md` for inline strips, `rounded-xl` for
 * standalone blocks); the surface itself was hand-written in ~9 places.
 */
export const STATUS_PANEL_SHELL_CLASS = "border border-border/60 bg-background/35";

/**
 * The operator filter control surface. One 130-character string that the
 * incident timeline and the API-key inventory each declared for themselves.
 */
export const STATUS_FILTER_FIELD_CLASS =
  "h-11 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40";

/**
 * A labelled filter `<select>` — the twelve-line label/span/select block that
 * appeared nine times across the incident timeline and the API-key inventory
 * controls (WS8.9).
 *
 * `onChange` receives the raw string so call sites keep casting to their own
 * filter unions exactly as before.
 */
export function FilterSelect({
  label,
  value,
  onChange,
  className,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string, event: ChangeEvent<HTMLSelectElement>) => void;
  /** Grid placement only (e.g. `sm:col-span-2`) — never restyling. */
  className?: string;
  /** The `<option>` list. */
  children: ReactNode;
}) {
  return (
    <label className={cn("min-w-0 space-y-1", className)}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <select
        className={STATUS_FILTER_FIELD_CLASS}
        value={value}
        onChange={(event) => onChange(event.target.value, event)}
      >
        {children}
      </select>
    </label>
  );
}

export function SummaryBadge({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div
      className={cn(
        // Static value chip: intentionally flat (no control-pill inset sheen)
        // so read-only metrics do not read as interactive mode controls.
        "rounded-full border border-border/60 bg-background/80 px-3 py-1.5 text-xs dark:bg-background/45",
        className,
      )}
    >
      <span className="text-muted-foreground">{label}</span>
      {/* Zero stays quiet: colour and weight are reserved for counts that need a look. */}
      <span className={cn("ml-1.5 pharos-numeric", value === "0" ? "text-muted-foreground" : "text-foreground")}>{value}</span>
    </div>
  );
}

export function StatusSection({
  id,
  kicker,
  title,
  description,
  summary,
  headingLevel = "h2",
  variant = "card",
  children,
}: {
  id: DashboardSectionId;
  kicker?: string;
  title: string;
  description?: string;
  summary?: ReactNode;
  headingLevel?: "h1" | "h2";
  variant?: "card" | "workspace";
  children: ReactNode;
}) {
  const Heading = headingLevel;

  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={cn(
        variant === "card"
          ? "pharos-card-shell scroll-mt-36 px-4 py-5 md:scroll-mt-28 sm:px-5 lg:px-6"
          : "min-w-0 max-w-full scroll-mt-[var(--ops-sticky-offset)]",
      )}
    >
      <div
        className={cn(
          "flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between",
          variant === "workspace" && "border-b border-border/70 pb-4",
        )}
      >
        <div className="space-y-1">
          {kicker && <p className="pharos-label">{kicker}</p>}
          <Heading id={`${id}-title`} className="text-2xl font-bold leading-tight text-foreground">
            {title}
          </Heading>
          {description && <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">{description}</p>}
        </div>
        {summary ? <div className="flex flex-wrap gap-2 lg:justify-end">{summary}</div> : null}
      </div>
      <div className="mt-5 space-y-5">
        {headingLevel === "h1" ? <h2 className="sr-only">{title} workspace content</h2> : null}
        {children}
      </div>
    </section>
  );
}

export function StatusCardEmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle as="h3" className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">{children}</p>
      </CardContent>
    </Card>
  );
}

export function NoticeRail({ notices }: { notices: DashboardNotice[] }) {
  if (notices.length === 0) return null;

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {notices.map((notice) => (
        <div key={notice.id} className={cn("rounded-xl border px-4 py-3", getNoticeTone(notice.tone))}>
          <div className="text-sm font-medium">{notice.title}</div>
          <div className="mt-1 text-xs leading-relaxed opacity-90">{notice.detail}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * Operator verdict pill: the single "do I need to act?" vocabulary shared by
 * every admin workspace (`OPERATOR_VERDICT_TONE`).
 */
export function VerdictPill({ verdict, label, className }: { verdict: OperatorVerdict; label?: string; className?: string }) {
  const tone = OPERATOR_VERDICT_TONE[verdict];
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium", tone.pill, className)}>
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", tone.dot)} />
      {label ?? tone.label}
    </span>
  );
}

/**
 * Collapsed raw codes and state words (reason codes, enum values) kept
 * reachable for operators without leading the row (R4 stays satisfied).
 */
export function TechnicalDetail({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <details className={cn("text-xs text-muted-foreground", className)}>
      <summary className="pharos-focus-ring cursor-pointer rounded-sm hover:text-foreground">Technical detail</summary>
      <div className="mt-1 break-all font-mono">{children}</div>
    </details>
  );
}

/** Public component state pill (`PUBLIC_COMPONENT_STATE_TONE`). */
export function ComponentStatePill({ state, className }: { state: PublicComponentState; className?: string }) {
  const tone = PUBLIC_COMPONENT_STATE_TONE[state];
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium", tone.pill, className)}>
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", tone.dot)} />
      {tone.label}
    </span>
  );
}

/** Elapsed span since an instant ("2h 10m"); defaults to the client clock like `timeAgo`. */
function elapsedSince(epochSec: number, nowSec = Date.now() / 1000): string {
  return formatElapsedSeconds(Math.max(0, nowSec - epochSec));
}

/**
 * Relative time with the exact instant on hover and in `dateTime`. Use it for
 * every operator/status timestamp instead of long inline locale strings.
 * `null` renders the unavailable dash, never a fabricated time (R1).
 * `variant="duration"` renders the elapsed span alone ("2h 10m") for
 * "For 2h 10m" phrasing, so "Since 2h ago" never appears.
 */
export function Timestamp({
  epochSec,
  nowSec,
  className,
  fallback = "—",
  variant = "ago",
}: {
  epochSec: number | null | undefined;
  nowSec?: number;
  className?: string;
  fallback?: string;
  variant?: "ago" | "duration";
}) {
  if (epochSec == null || !Number.isFinite(epochSec) || epochSec <= 0) {
    return <span className={cn("text-muted-foreground", className)}>{fallback}</span>;
  }
  const date = new Date(epochSec * 1000);
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString()} className={cn("pharos-numeric whitespace-nowrap", className)}>
      {variant === "duration"
        ? elapsedSince(epochSec, nowSec)
        : timeAgo(epochSec, nowSec)}
    </time>
  );
}

/**
 * A count that stays quiet at zero: zero is muted grey, a positive count takes
 * the given tone, and `null` is the unavailable dash, never zero (R1).
 */
export function CountValue({
  value,
  tone = "text-foreground",
  className,
}: {
  value: number | null | undefined;
  /** Static Tailwind text class applied only when the count is positive. */
  tone?: string;
  className?: string;
}) {
  if (value == null) return <span className={cn("pharos-numeric text-muted-foreground", className)}>—</span>;
  return (
    <span className={cn("pharos-numeric", value === 0 ? "text-muted-foreground" : tone, className)}>
      {value.toLocaleString()}
    </span>
  );
}
