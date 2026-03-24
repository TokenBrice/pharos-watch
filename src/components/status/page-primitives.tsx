import type { ReactNode } from "react";
import {
  getNoticeTone,
  type DashboardNotice,
  type DashboardSection,
  type DashboardSectionId,
} from "@/lib/status-dashboard-model";
import { cn } from "@/lib/utils";

export function SummaryBadge({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-full border border-border/60 bg-background/80 px-3 py-1.5 text-xs shadow-[inset_0_1px_0_oklch(1_0_0_/0.55)] dark:bg-background/45 dark:shadow-none",
        className,
      )}
    >
      <span className="text-muted-foreground">{label}</span>
      <span className="ml-1.5 font-mono tabular-nums text-foreground">{value}</span>
    </div>
  );
}

export function StatusSection({
  id,
  kicker,
  title,
  description,
  accentClassName,
  summary,
  children,
}: {
  id: DashboardSectionId;
  kicker: string;
  title: string;
  description: string;
  accentClassName: string;
  summary?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className={cn(
        "scroll-mt-36 rounded-[1.5rem] border border-border/70 border-l-[3px] bg-card/82 px-4 py-5 shadow-[0_18px_40px_oklch(0_0_0_/0.08)] dark:shadow-[0_18px_40px_oklch(0_0_0_/0.14)] md:scroll-mt-28 sm:px-5 lg:px-6",
        accentClassName,
      )}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-2">
          <p className="pharos-kicker">{kicker}</p>
          <div className="space-y-1">
            <h2 className="text-xl font-semibold tracking-tight text-foreground sm:text-[1.35rem]">{title}</h2>
            <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">{description}</p>
          </div>
        </div>
        {summary ? <div className="flex flex-wrap gap-2 lg:justify-end">{summary}</div> : null}
      </div>
      <div className="mt-5 space-y-5">{children}</div>
    </section>
  );
}

export function PriorityLaneLink({ section, index }: { section: DashboardSection; index: number }) {
  return (
    <a
      href={`#${section.id}`}
      className={cn(
        "pharos-focus-ring group flex items-start justify-between gap-4 border-t border-border/60 py-3.5 first:border-t-0",
        "transition-colors hover:text-foreground",
      )}
    >
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-base leading-none text-muted-foreground/80 dark:text-white/35">{String(index + 1).padStart(2, "0")}</span>
          <p className="pharos-kicker">{section.label}</p>
        </div>
        <div className="text-base font-semibold tracking-tight text-foreground">{section.title}</div>
        <div className="text-xs leading-relaxed text-muted-foreground">{section.summary}</div>
      </div>
      <span
        className={cn(
          "rounded-full border border-border/60 bg-background/55 px-2.5 py-1 text-[11px] font-medium text-foreground",
          section.valueClassName,
        )}
      >
        {section.value}
      </span>
    </a>
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
