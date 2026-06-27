"use client";

import Link from "next/link";
import { useMemo, useState, type JSX } from "react";
import { Check, ChevronLeft, ChevronRight, Pencil, Plus, RotateCcw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { NAV_ITEMS, type NavItem } from "@/lib/nav-config";
import { DEFAULT_SHORTCUT_HREFS, useShortcuts } from "@/hooks/use-shortcuts";
import { cn } from "@/lib/utils";

const NAV_BY_HREF = new Map<string, NavItem>(NAV_ITEMS.map((item) => [item.href, item]));

// Per-destination icon tone, keyed by nav href. Mirrors the Figma "Shortcuts"
// band where each chip carries a colored category glyph. Static class strings
// only — color stays confined to the icon tile so the unified shortcut panel
// remains calm while the twelve default routes are individually recognizable.
const SHORTCUT_ICON_TONE: Record<string, string> = {
  "/chains/": "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-300",
  "/upcoming/": "border-amber-500/25 bg-amber-500/12 text-amber-600 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-300",
  "/portfolio/": "border-purple-500/20 bg-purple-500/10 text-purple-600 dark:border-purple-400/20 dark:bg-purple-400/10 dark:text-purple-300",
  "/alt-pegs/": "border-blue-500/20 bg-blue-500/10 text-blue-600 dark:border-blue-400/20 dark:bg-blue-400/10 dark:text-blue-300",
  "/cemetery/": "border-red-500/20 bg-red-500/10 text-red-600 dark:border-red-400/20 dark:bg-red-400/10 dark:text-red-300",
  "https://pharosville.pharos.watch/": "border-teal-500/20 bg-teal-500/10 text-teal-600 dark:border-teal-400/20 dark:bg-teal-400/10 dark:text-teal-300",
  "/yield/": "border-lime-500/25 bg-lime-500/12 text-lime-700 dark:border-lime-400/20 dark:bg-lime-400/10 dark:text-lime-300",
  "/liquidity/": "border-cyan-500/20 bg-cyan-500/10 text-cyan-600 dark:border-cyan-400/20 dark:bg-cyan-400/10 dark:text-cyan-300",
  "/screener/": "border-indigo-500/20 bg-indigo-500/10 text-indigo-600 dark:border-indigo-400/20 dark:bg-indigo-400/10 dark:text-indigo-300",
  "/compare/": "border-orange-500/25 bg-orange-500/12 text-orange-600 dark:border-orange-400/20 dark:bg-orange-400/10 dark:text-orange-300",
  "/dependency-map/": "border-violet-500/20 bg-violet-500/10 text-violet-600 dark:border-violet-400/20 dark:bg-violet-400/10 dark:text-violet-300",
  "/timeline/": "border-rose-500/20 bg-rose-500/10 text-rose-600 dark:border-rose-400/20 dark:bg-rose-400/10 dark:text-rose-300",
};
const FALLBACK_SHORTCUT_ICON_TONE =
  "border-sky-500/20 bg-sky-500/10 text-sky-600 dark:border-sky-400/20 dark:bg-sky-400/10 dark:text-sky-300";

function externalLinkProps(item: NavItem): { target?: string; rel?: string } {
  return item.external ? { target: "_blank", rel: "noopener noreferrer" } : {};
}

// Flat icon tile shared by view + edit chips. The tile stays neutral; only the
// glyph takes a per-destination category hue so the row reads as colored
// categories while the chips themselves remain calm.
function ShortcutIcon({ item }: { item: NavItem }): JSX.Element {
  const Icon = item.icon;
  const iconTone = SHORTCUT_ICON_TONE[item.href] ?? FALLBACK_SHORTCUT_ICON_TONE;
  return (
    <span
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-lg border",
        iconTone,
      )}
    >
      <Icon aria-hidden="true" className="size-[18px]" strokeWidth={1.85} />
    </span>
  );
}

// Default (non-editing) cell: a link to the destination. Carries hairline
// right/bottom dividers so the cells tile into one unified bordered panel; the
// wrapping container clips the trailing edge borders (see render below).
function ShortcutLink({ item, className }: { item: NavItem; className?: string }): JSX.Element {
  return (
    <Link
      href={item.href}
      {...externalLinkProps(item)}
      className={cn(
        "pharos-focus-ring flex items-center gap-3 border-b border-r border-border/70 px-4 py-3.5 transition-colors hover:bg-muted/30",
        className,
      )}
    >
      <ShortcutIcon item={item} />
      <span className="min-w-0 truncate text-sm font-medium text-foreground">{item.label}</span>
    </Link>
  );
}

// Edit chip: reorder + remove controls, no navigation.
function EditableShortcut({
  item,
  index,
  total,
  onMove,
  onRemove,
}: {
  item: NavItem;
  index: number;
  total: number;
  onMove: (href: string, direction: -1 | 1) => void;
  onRemove: (href: string) => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-border/70 bg-card/60 px-3.5 py-3">
      <div className="flex items-center gap-3">
        <ShortcutIcon item={item} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{item.label}</span>
      </div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onMove(item.href, -1)}
            disabled={index === 0}
            aria-label={`Move ${item.label} earlier`}
            className="pharos-focus-ring grid size-7 place-items-center rounded-md border border-border/60 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          >
            <ChevronLeft aria-hidden="true" className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => onMove(item.href, 1)}
            disabled={index === total - 1}
            aria-label={`Move ${item.label} later`}
            className="pharos-focus-ring grid size-7 place-items-center rounded-md border border-border/60 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          >
            <ChevronRight aria-hidden="true" className="size-4" />
          </button>
        </div>
        <button
          type="button"
          onClick={() => onRemove(item.href)}
          aria-label={`Remove ${item.label} shortcut`}
          className="pharos-focus-ring grid size-7 place-items-center rounded-md border border-border/60 text-muted-foreground transition-colors hover:border-destructive/50 hover:bg-destructive/10 hover:text-destructive"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
    </div>
  );
}

export function ShortcutsSection(): JSX.Element {
  const { hrefs, add, remove, move, reset } = useShortcuts();
  const [editing, setEditing] = useState(false);

  // Resolve stored hrefs to nav metadata, dropping any that no longer exist.
  const items = useMemo(
    () => hrefs.flatMap((href) => NAV_BY_HREF.get(href) ?? []),
    [hrefs],
  );

  const desktopFillItems = useMemo(() => {
    if (items.length >= DEFAULT_SHORTCUT_HREFS.length) return [];
    const selected = new Set(items.map((item) => item.href));
    return DEFAULT_SHORTCUT_HREFS.flatMap((href) => {
      if (selected.has(href)) return [];
      const item = NAV_BY_HREF.get(href);
      return item ? [item] : [];
    }).slice(0, DEFAULT_SHORTCUT_HREFS.length - items.length);
  }, [items]);

  // Destinations the user can still add (everything not already pinned).
  const available = useMemo(() => {
    const selected = new Set(hrefs);
    return NAV_ITEMS.filter((item) => !selected.has(item.href));
  }, [hrefs]);

  const isDefault = useMemo(
    () =>
      hrefs.length === DEFAULT_SHORTCUT_HREFS.length &&
      hrefs.every((href, index) => href === DEFAULT_SHORTCUT_HREFS[index]),
    [hrefs],
  );

  return (
    <section aria-labelledby="shortcuts-title" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="space-y-1.5">
          <h2 id="shortcuts-title" className="pharos-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            Shortcuts
          </h2>
          <p className="text-sm text-muted-foreground">
            Your saved shortcuts — fast access to what you check most.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setEditing((value) => !value)}
          aria-pressed={editing}
        >
          {editing ? (
            <>
              <Check aria-hidden="true" />
              Done
            </>
          ) : (
            <>
              <Pencil aria-hidden="true" />
              Edit
            </>
          )}
        </Button>
      </div>

      {items.length === 0 && !editing ? (
        <p className="rounded-xl border border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
          No shortcuts yet — tap <span className="font-medium text-foreground">Edit</span> to add some.
        </p>
      ) : editing ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {items.map((item, index) => (
            <EditableShortcut
              key={item.href}
              item={item}
              index={index}
              total={items.length}
              onMove={move}
              onRemove={remove}
            />
          ))}
        </div>
      ) : (
        // One unified bordered panel: cells carry right/bottom hairlines and the
        // grid is nudged 1px past the rounded, clipped frame so the trailing
        // edge borders disappear and only the internal dividers read.
        <div className="overflow-hidden rounded-xl border border-border/70">
          <div className="-mb-px -mr-px grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
            {items.map((item) => (
              <ShortcutLink key={item.href} item={item} />
            ))}
            {desktopFillItems.map((item) => (
              <ShortcutLink key={`desktop-fill-${item.href}`} item={item} className="hidden lg:flex" />
            ))}
          </div>
        </div>
      )}

      {editing && (
        <div className="space-y-3 rounded-xl border border-border/60 bg-muted/20 p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="pharos-kicker">Add a shortcut</p>
            <button
              type="button"
              onClick={reset}
              disabled={isDefault}
              className="pharos-focus-ring inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            >
              <RotateCcw aria-hidden="true" className="size-3.5" />
              Reset to defaults
            </button>
          </div>
          {available.length === 0 ? (
            <p className="text-xs text-muted-foreground">Every destination is already saved.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {available.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.href}
                    type="button"
                    onClick={() => add(item.href)}
                    aria-label={`Add ${item.label} shortcut`}
                    className={cn(
                      "pharos-focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-card/60 px-2.5 py-1.5 text-[13px] font-medium text-foreground transition-colors",
                      "hover:border-border hover:bg-muted/50",
                    )}
                  >
                    <Icon aria-hidden="true" className="size-3.5 text-muted-foreground" strokeWidth={1.85} />
                    {item.label}
                    <Plus aria-hidden="true" className="size-3.5 text-muted-foreground" />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
