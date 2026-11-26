"use client";

import { createContext, memo, useContext, useMemo } from "react";
import { ChevronRight, ChevronsUpDown, LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TelegramWebAppSdk } from "../telegram-sdk";

export const MiniAppHapticsContext = createContext<TelegramWebAppSdk["HapticFeedback"] | null>(null);

export function useMiniAppHaptics(): TelegramWebAppSdk["HapticFeedback"] | null {
  return useContext(MiniAppHapticsContext);
}

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

function RowBody({ title, subtitle, value, tone = "default", leading, chevron, trailing, loading, wrap }: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  value?: React.ReactNode;
  tone?: RowTone;
  leading?: React.ReactNode;
  chevron?: boolean;
  trailing?: React.ReactNode;
  loading?: boolean;
  wrap?: boolean;
}) {
  return (
    <>
      {leading ? <span className="flex shrink-0 items-center">{leading}</span> : null}
      <span className={cn("min-w-0 flex-1 py-2.5", wrap && "min-w-[8rem]")}>
        <span
          className={cn(
            "block truncate text-sm",
            tone === "accent" && "text-[color:var(--telegram-link,var(--mini-accent))]",
            tone === "destructive" && "text-[color:var(--telegram-destructive-text,var(--state-danger-text))]",
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
const INSET_FOCUS_CLASS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring first:rounded-t-xl last:rounded-b-xl";

/** A static or tappable row. Tappable rows render as buttons with ≥44px height. */
export function ListRow({ onClick, disabled, ariaLabel, ariaChecked, wrap, className, ...body }: Parameters<typeof RowBody>[0] & {
  onClick?: () => void;
  disabled?: boolean;
  ariaLabel?: string;
  /** Set to render the row as a checkbox (multi-select lists). */
  ariaChecked?: boolean;
  /** Allow trailing controls (such as ChoiceChips) to wrap onto a second line on narrow screens. */
  wrap?: boolean;
  className?: string;
}) {
  const rowClasses = cn(
    ROW_CLASS,
    body.leading && "before:left-11",
    wrap && "flex-wrap gap-x-3 gap-y-1",
    className,
  );
  if (!onClick) {
    return <div className={rowClasses}><RowBody {...body} wrap={wrap} /></div>;
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
      className={cn(
        rowClasses,
        INSET_FOCUS_CLASS,
        "transition-colors active:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-50",
      )}
    >
      <RowBody {...body} wrap={wrap} />
    </button>
  );
}

/** On/off switch. The track uses the host button colour; the knob keeps contrast on both tracks. */
export function Switch({ checked, disabled, loading, queued, allowWhileLoading, label, description, onChange }: {
  checked: boolean;
  disabled?: boolean;
  loading?: boolean;
  /** True when a coalesced follow-up toggle for this switch is queued behind an in-flight write. */
  queued?: boolean;
  /** Keep interactive while saving so rapid double-taps fold against the last intended value. */
  allowWhileLoading?: boolean;
  label: string;
  /** The row subtitle, appended so screen readers hear what the switch covers. */
  description?: string;
  onChange: (next: boolean) => void;
}) {
  const haptics = useMiniAppHaptics();
  const baseLabel = description ? `${label}: ${description}` : label;
  const ariaLabel = queued ? `${baseLabel} (change queued)` : baseLabel;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-busy={loading || undefined}
      data-queued={queued ? "true" : undefined}
      disabled={disabled || (!allowWhileLoading && loading)}
      onClick={() => {
        haptics?.selectionChanged?.();
        onChange(!checked);
      }}
      className="pharos-focus-ring group -my-1 -mr-1 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full disabled:cursor-not-allowed"
    >
      <span
        className={cn(
          "relative inline-flex h-7 w-12 items-center rounded-full border transition-colors group-disabled:opacity-50",
          checked
            ? "border-transparent bg-[var(--telegram-button,var(--mini-accent))]"
            : "border-[color:var(--border)] bg-[var(--telegram-switch-off-bg,color-mix(in_oklab,var(--mini-text)_42%,var(--mini-card)))]",
          queued && "ring-2 ring-[color:var(--telegram-link,var(--mini-accent))] ring-offset-2 ring-offset-[var(--mini-card)]",
        )}
      >
        <span
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-full shadow-sm transition-transform",
            checked
              ? "translate-x-[1.3125rem] bg-[var(--telegram-button-text,white)]"
              : "translate-x-0.5 bg-white",
          )}
        >
          {loading ? (
            <LoaderCircle
              className={cn(
                "h-3.5 w-3.5 animate-spin",
                checked ? "text-[color:var(--telegram-button,var(--mini-accent))]" : "text-neutral-600",
              )}
              aria-hidden="true"
            />
          ) : queued ? (
            <span
              className="h-2 w-2 rounded-full bg-[var(--telegram-button,var(--mini-accent))]"
              aria-hidden="true"
            />
          ) : null}
        </span>
      </span>
    </button>
  );
}

export interface SelectRowOption<T extends string = string> {
  value: T;
  label: string;
  group?: string;
  disabled?: boolean;
}

export interface SelectRowProps<T extends string> {
  id: string;
  title: string;
  subtitle?: string;
  value: T;
  options: readonly SelectRowOption<T>[];
  disabled?: boolean;
  loading?: boolean;
  /** True when a coalesced follow-up value for this picker is queued behind an in-flight write. */
  queued?: boolean;
  /** Keep interactive while saving so additional selections can coalesce on the same entity. */
  allowWhileLoading?: boolean;
  onChange: (next: T) => void;
  inset?: boolean;
  numericValue?: boolean;
}

/** A row whose value is a native picker; commits on change. Memoized so clock ticks skip re-reconciling large option lists. */
function SelectRowImpl<T extends string>({
  id,
  title,
  subtitle,
  value,
  options,
  disabled,
  loading,
  queued,
  allowWhileLoading,
  onChange,
  inset,
  numericValue,
}: SelectRowProps<T>) {
  const haptics = useMiniAppHaptics();
  const isDisabled = Boolean(disabled || (!allowWhileLoading && loading));
  const groupedOptions = useMemo(() => {
    const byGroup = new Map<string, SelectRowOption<T>[]>();
    for (const option of options) {
      const group = option.group ?? "";
      const list = byGroup.get(group);
      if (list) list.push(option);
      else byGroup.set(group, [option]);
    }
    return [...byGroup.entries()];
  }, [options]);
  const optionNodes = useMemo(() => {
    const renderOption = (option: SelectRowOption<T>) => (
      <option key={option.value} value={option.value} disabled={option.disabled}>
        {option.label}
      </option>
    );
    return groupedOptions.length > 1
      ? groupedOptions.map(([group, groupOptions]) => (
        <optgroup key={group} label={group}>
          {groupOptions.map(renderOption)}
        </optgroup>
      ))
      : options.map(renderOption);
  }, [groupedOptions, options]);
  const selected = useMemo(
    () => options.find((option) => option.value === value),
    [options, value],
  );
  return (
    <div
      className={cn(
        ROW_CLASS,
        "transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-ring first:rounded-t-xl last:rounded-b-xl",
        !isDisabled && "active:bg-muted/60",
        isDisabled && "opacity-50",
        queued && "ring-1 ring-inset ring-[color:var(--telegram-link,var(--mini-accent))]",
        inset && "pl-8 before:hidden",
      )}
    >
      <label htmlFor={id} className="min-w-0 flex-1 py-2.5">
        <span className={cn("block truncate", inset ? "text-xs text-muted-foreground" : "text-sm text-foreground")}>{title}</span>
        {subtitle ? <span className="mt-0.5 block text-xs leading-snug text-pretty text-muted-foreground">{subtitle}</span> : null}
      </label>
      {loading ? <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" /> : null}
      {queued ? (
        <>
          <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--telegram-button,var(--mini-accent))]" aria-hidden="true" />
          <span className="sr-only">Change queued</span>
        </>
      ) : null}
      <span className="pointer-events-none flex max-w-[60%] shrink-0 items-center gap-1 text-sm text-[color:var(--telegram-link,var(--mini-accent))]">
        <span className={cn("truncate", numericValue && "tabular-nums")}>{selected?.label ?? value}</span>
        <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-70" aria-hidden="true" />
      </span>
      <select
        id={id}
        value={value}
        disabled={isDisabled}
        aria-busy={loading || undefined}
        data-queued={queued ? "true" : undefined}
        onChange={(event) => {
          haptics?.selectionChanged?.();
          onChange(event.target.value as T);
        }}
        className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0 focus:outline-none disabled:cursor-not-allowed"
      >
        {optionNodes}
      </select>
    </div>
  );
}

export const SelectRow = memo(SelectRowImpl) as typeof SelectRowImpl;

/** Inline one-tap choices (e.g. snooze durations) with ≥44px hit areas around compact pills. */
export function ChoiceChips<T extends string>({ label, options, disabled, pendingValue, queuedValue, allowWhileLoading, onSelect }: {
  label: string;
  options: readonly { value: T; label: string; ariaLabel?: string }[];
  disabled?: boolean;
  pendingValue?: T | null;
  queuedValue?: T | null;
  allowWhileLoading?: boolean;
  onSelect: (value: T) => void;
}) {
  const haptics = useMiniAppHaptics();
  return (
    <div role="group" aria-label={label} className="-my-1 -mr-2 flex shrink-0 flex-wrap items-center">
      {options.map((option) => {
        const isPending = pendingValue === option.value;
        const isQueued = queuedValue === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-label={option.ariaLabel}
            aria-busy={isPending || undefined}
            data-queued={isQueued ? "true" : undefined}
            disabled={disabled || (!allowWhileLoading && pendingValue != null)}
            onClick={() => {
              haptics?.selectionChanged?.();
              onSelect(option.value);
            }}
            className="pharos-focus-ring group inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg px-0.5 disabled:cursor-not-allowed"
          >
            <span
              className={cn(
                "inline-flex h-8 min-w-10 items-center justify-center gap-1 rounded-md bg-[var(--mini-control)] px-2.5 text-sm font-medium whitespace-nowrap tabular-nums text-foreground group-active:opacity-70 group-disabled:opacity-50",
                isQueued && "ring-2 ring-[color:var(--telegram-link,var(--mini-accent))]",
              )}
            >
              {isPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
              {!isPending && isQueued ? <span className="h-2 w-2 rounded-full bg-[var(--telegram-button,var(--mini-accent))]" aria-hidden="true" /> : null}
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
