"use client";

import { ChevronRight, LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/** Borderless grouped list on Telegram's section background (iOS/Android settings idiom). */
export function ListSection({ title, trailing, footer, children, className }: {
  title?: string;
  trailing?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("mt-6 first:mt-0", className)}>
      {title || trailing ? (
        <div className="flex min-h-6 items-end justify-between gap-3 px-4 pb-1.5">
          {title ? <h2 className="text-xs font-medium text-[color:var(--telegram-section-header-text,var(--muted-foreground))]">{title}</h2> : <span />}
          {trailing}
        </div>
      ) : null}
      <div className="overflow-hidden rounded-xl bg-[var(--mini-card)]">
        {children}
      </div>
      {footer ? <p className="px-4 pt-1.5 text-xs leading-snug text-muted-foreground">{footer}</p> : null}
    </section>
  );
}

type RowTone = "default" | "accent" | "destructive";

function RowBody({ title, subtitle, value, tone = "default", leading, chevron, trailing, loading }: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  value?: React.ReactNode;
  tone?: RowTone;
  leading?: React.ReactNode;
  chevron?: boolean;
  trailing?: React.ReactNode;
  loading?: boolean;
}) {
  return (
    <>
      {leading ? <span className="flex shrink-0 items-center">{leading}</span> : null}
      <span className="min-w-0 flex-1 py-2.5">
        <span
          className={cn(
            "block truncate text-sm",
            tone === "accent" && "text-[color:var(--telegram-link,var(--mini-accent))]",
            tone === "destructive" && "text-[color:var(--telegram-destructive-text,var(--color-state-danger-solid))]",
            tone === "default" && "text-foreground",
          )}
        >
          {title}
        </span>
        {subtitle ? <span className="mt-0.5 block text-xs leading-snug text-pretty text-muted-foreground">{subtitle}</span> : null}
      </span>
      {value != null ? <span className="max-w-[55%] shrink-0 truncate text-right text-sm text-muted-foreground">{value}</span> : null}
      {loading ? <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" /> : null}
      {trailing}
      {chevron ? <ChevronRight className="-mr-1 h-4 w-4 shrink-0 text-muted-foreground/70" aria-hidden="true" /> : null}
    </>
  );
}

// Hairline separator inset 16px from the leading edge, hidden on the first row.
const ROW_CLASS = "relative flex min-h-11 w-full items-center gap-3 px-4 text-left before:pointer-events-none before:absolute before:left-4 before:right-0 before:top-0 before:h-px before:bg-border/30 first:before:hidden";

/** A static or tappable row. Tappable rows render as buttons with ≥44px height. */
export function ListRow({ onClick, disabled, ariaLabel, ariaChecked, className, ...body }: Parameters<typeof RowBody>[0] & {
  onClick?: () => void;
  disabled?: boolean;
  ariaLabel?: string;
  /** Set to render the row as a checkbox (multi-select lists). */
  ariaChecked?: boolean;
  className?: string;
}) {
  if (!onClick) {
    return <div className={cn(ROW_CLASS, className)}><RowBody {...body} /></div>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || body.loading}
      role={ariaChecked == null ? undefined : "checkbox"}
      aria-checked={ariaChecked}
      aria-label={ariaLabel}
      aria-busy={body.loading || undefined}
      className={cn(ROW_CLASS, "pharos-focus-ring transition-colors active:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-50", className)}
    >
      <RowBody {...body} />
    </button>
  );
}

/** On/off switch. The track uses the host button colour; the knob keeps contrast on both tracks. */
export function Switch({ checked, disabled, loading, label, description, onChange }: {
  checked: boolean;
  disabled?: boolean;
  loading?: boolean;
  label: string;
  /** The row subtitle, appended so screen readers hear what the switch covers. */
  description?: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={description ? `${label}: ${description}` : label}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      onClick={() => onChange(!checked)}
      className="pharos-focus-ring group -my-1 -mr-1 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full disabled:cursor-not-allowed"
    >
      <span
        className={cn(
          "relative inline-flex h-7 w-12 items-center rounded-full transition-colors group-disabled:opacity-50",
          checked ? "bg-[var(--telegram-button,var(--mini-accent))]" : "bg-[color-mix(in_oklab,var(--mini-text)_22%,var(--mini-card))]",
        )}
      >
        <span
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-full bg-white shadow-sm transition-transform",
            checked ? "translate-x-[1.375rem]" : "translate-x-0.5",
          )}
        >
          {loading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin text-neutral-500" aria-hidden="true" /> : null}
        </span>
      </span>
    </button>
  );
}

/** A row whose value is a native picker; commits on change. */
export function SelectRow<T extends string>({ id, title, subtitle, value, options, disabled, loading, onChange, inset }: {
  id: string;
  title: string;
  subtitle?: string;
  value: T;
  options: readonly { value: T; label: string; group?: string }[];
  disabled?: boolean;
  loading?: boolean;
  onChange: (next: T) => void;
  inset?: boolean;
}) {
  const groups = [...new Set(options.map((option) => option.group ?? ""))];
  const renderOption = (option: { value: T; label: string }) => <option key={option.value} value={option.value}>{option.label}</option>;
  const selected = options.find((option) => option.value === value);
  return (
    <div className={cn(ROW_CLASS, inset && "pl-8 before:hidden")}>
      <label htmlFor={id} className="min-w-0 flex-1 py-2.5">
        <span className={cn("block truncate", inset ? "text-xs text-muted-foreground" : "text-sm text-foreground")}>{title}</span>
        {subtitle ? <span className="mt-0.5 block text-xs leading-snug text-pretty text-muted-foreground">{subtitle}</span> : null}
      </label>
      {loading ? <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" /> : null}
      <span className="pointer-events-none flex max-w-[60%] shrink-0 items-center gap-1 text-sm text-[color:var(--telegram-link,var(--mini-accent))]">
        <span className="truncate">{selected?.label ?? value}</span>
        <ChevronRight className="h-4 w-4 shrink-0 rotate-90 opacity-70" aria-hidden="true" />
      </span>
      <select
        id={id}
        value={value}
        disabled={disabled || loading}
        onChange={(event) => onChange(event.target.value as T)}
        className="pharos-focus-ring absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0 disabled:cursor-not-allowed"
      >
        {groups.length > 1
          ? groups.map((group) => (
            <optgroup key={group} label={group}>
              {options.filter((option) => (option.group ?? "") === group).map(renderOption)}
            </optgroup>
          ))
          : options.map(renderOption)}
      </select>
    </div>
  );
}

/** Inline one-tap choices (e.g. snooze durations) with ≥44px hit areas around compact pills. */
export function ChoiceChips<T extends string>({ label, options, disabled, pendingValue, onSelect }: {
  label: string;
  options: readonly { value: T; label: string; ariaLabel?: string }[];
  disabled?: boolean;
  pendingValue?: T | null;
  onSelect: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="-my-1 -mr-2 flex shrink-0 items-center">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-label={option.ariaLabel}
          aria-busy={pendingValue === option.value || undefined}
          disabled={disabled || pendingValue != null}
          onClick={() => onSelect(option.value)}
          className="pharos-focus-ring group inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg px-0.5 disabled:cursor-not-allowed"
        >
          <span className="inline-flex h-8 min-w-10 items-center justify-center gap-1 rounded-md bg-[var(--mini-control)] px-2.5 text-sm font-medium whitespace-nowrap text-foreground group-active:opacity-70 group-disabled:opacity-50">
            {pendingValue === option.value ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
            {option.label}
          </span>
        </button>
      ))}
    </div>
  );
}
