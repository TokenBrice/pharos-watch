import type { ChangeEvent, ReactNode } from "react";
import {
  getNoticeTone,
  getStatusTone,
  type DashboardNotice,
  type DashboardSectionId,
} from "@/lib/status-dashboard-model";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { DataTableColumn } from "@/components/data-table-shell";
import { cn } from "@/lib/utils";

export function defineStatusColumns(columns: readonly (readonly [id: string, label: string])[]): readonly DataTableColumn[] {
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
      <span className="ml-1.5 pharos-numeric text-foreground">{value}</span>
    </div>
  );
}

export function StatusSummaryBadge({
  label,
  status,
  value,
  className,
}: {
  label: string;
  status: "healthy" | "degraded" | "stale";
  value?: string;
  className?: string;
}) {
  const tone = getStatusTone(status);

  return <SummaryBadge label={label} value={value ?? tone.label} className={cn(tone.badgeClassName, className)} />;
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
          {kicker && <p className="pharos-kicker">{kicker}</p>}
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
