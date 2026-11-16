"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { House } from "lucide-react";
import { ControlRoleTag } from "@/components/stablecoin-detail/control-role-tag";
import { cn } from "@/lib/utils";
import {
  BRIDGE_TIER_CELL_CLASSES,
  BRIDGE_TIER_POLICY_ORDER,
  BRIDGE_TIER_UNKNOWN_CELL_CLASS,
  CONTROL_COMPONENT_ROLE_LABELS,
  type ControlComponentRole,
} from "@shared/lib/classification";
import type { BridgeRouteRiskTier } from "@shared/types/bridge-risk";

export type DeploymentRouteRole = Extract<ControlComponentRole, "limiting" | "eligible" | "diagnostic">;

export interface DeploymentRoute {
  key: string;
  /** Chain or route name ("Ethereum", "Plasma · LayerZero"). */
  label: string;
  /** Bridge route tier key (`BridgeRouteRiskTier`); an unrecognised key groups as unknown. */
  tierKey: string;
  tierLabel: string;
  /**
   * Relation to the Control minimum: `limiting` draws a solid outline,
   * `diagnostic` (outside the eligible set) a dashed one; absent makes no claim.
   */
  role?: DeploymentRouteRole;
  home?: boolean;
  /** Tier not established for this route: it groups apart, whatever `tierKey` says. */
  unknown?: boolean;
}

export interface DeploymentRouteGroupsProps {
  routes: readonly DeploymentRoute[];
  /**
   * Inventory total per tier label, for routes that are a sample of a larger
   * inventory: each group then counts every route and names the ones not
   * listed as "+N more". Falls back to listed counts unless every group label
   * has a total.
   */
  totals?: Readonly<Record<string, number>>;
  /** Names the list ("Bridge routes by type"). */
  ariaLabel: string;
  /** Caller caveats, appended to the caption. Lower-case fragments. */
  caveats?: readonly string[];
  /**
   * Caption of a limiting input (plan §6) that no single route carries, such
   * as the engine's unverified-bridge fallback ("Bridge controls unverified"),
   * stated once above the groups so tier dots never read as safe beside a
   * limiting score.
   */
  bandLimiting?: string;
  className?: string;
}

/** Chain chips per group before "+N more". */
const CHIP_LIMIT = 8;

const CAPTION = "Grouped by how the token reaches each chain, strongest route type first. Supply per chain is not published, so routes are listed, not sized.";

/**
 * In a mixed group every chip states its role at one border weight: an
 * eligible chip draws the same visible outline as its dashed diagnostic
 * neighbours, solid, so it never reads as a chip that lost its border.
 */
const CHIP_ROLE_CLASS: Record<DeploymentRouteRole, string> = {
  limiting: "border-[1.5px] border-foreground/80 font-medium",
  diagnostic: "border-dashed border-muted-foreground/60",
  eligible: "border-muted-foreground/60",
};

/** The route's reviewed tier; null when it is not established or not a published tier. */
function resolveTier(route: DeploymentRoute): BridgeRouteRiskTier | null {
  return !route.unknown && Object.hasOwn(BRIDGE_TIER_CELL_CLASSES, route.tierKey)
    ? (route.tierKey as BridgeRouteRiskTier)
    : null;
}

interface RouteGroup {
  key: string;
  label: string;
  dotClass: string;
  rank: number;
  routes: DeploymentRoute[];
}

/** Routes grouped by tier in published policy order; unrecognised tiers, then unestablished ones, last. */
export function groupDeploymentRoutes(routes: readonly DeploymentRoute[]): RouteGroup[] {
  const policyOrder: readonly string[] = BRIDGE_TIER_POLICY_ORDER;
  const groups = new Map<string, RouteGroup>();
  for (const route of routes) {
    const tier = resolveTier(route);
    const key = route.unknown ? "unresolved" : route.tierKey;
    const group = groups.get(key);
    if (group) {
      group.routes.push(route);
      continue;
    }
    const policyIndex = policyOrder.indexOf(route.tierKey);
    groups.set(key, {
      key,
      label: route.tierLabel,
      dotClass: tier === null ? BRIDGE_TIER_UNKNOWN_CELL_CLASS : BRIDGE_TIER_CELL_CLASSES[tier],
      rank: route.unknown ? policyOrder.length + 1 : policyIndex === -1 ? policyOrder.length : policyIndex,
      routes: [route],
    });
  }
  return [...groups.values()].sort((left, right) => left.rank - right.rank);
}

/** `markRole`: false when the group's header tag already names the role every route shares. */
function RouteChip({ route, markRole }: { route: DeploymentRoute; markRole: boolean }) {
  return (
    <li
      data-route={route.key}
      data-role={route.role}
      title={markRole && route.role ? CONTROL_COMPONENT_ROLE_LABELS[route.role] : undefined}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-md border bg-background/70 px-1.5 py-0.5 text-2xs leading-tight text-foreground",
        markRole && route.role ? CHIP_ROLE_CLASS[route.role] : "border-border/60",
      )}
    >
      {route.home ? <House data-home-glyph="" aria-hidden="true" className="h-3 w-3 shrink-0" /> : null}
      <span className="min-w-0 wrap-anywhere">{route.label}</span>
      {route.home || (route.role && route.role !== "eligible") ? (
        <span className="sr-only">
          {[route.home ? "home chain" : null, route.role && route.role !== "eligible" ? CONTROL_COMPONENT_ROLE_LABELS[route.role] : null]
            .filter(Boolean)
            .map((part) => `, ${part}`)
            .join("")}
        </span>
      ) : null}
    </li>
  );
}

/** Room for the "+N more" count to gain a digit when a chip moves behind it. */
const MORE_DIGIT_ROOM_PX = 8;

/**
 * A group's chain chips. When the group lists fewer chips than it counts, the
 * chips and the "+N more" share one row: chips that would push the count onto
 * a row of its own (one chip and "+N more" stranded under a full row) move
 * behind it instead. Chip widths are measured once, while every listed chip
 * renders, so the row refits on resize; without layout (server render, tests)
 * every listed chip shows.
 */
function RouteChipList({
  label,
  routes,
  count,
  markRole,
}: {
  label: string;
  routes: readonly DeploymentRoute[];
  count: number;
  markRole: boolean;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const widthsRef = useRef<number[] | null>(null);
  const listed = routes.slice(0, CHIP_LIMIT);
  const [fit, setFit] = useState(listed.length);
  const overflows = count > listed.length;

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !overflows || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const chips = Array.from(list.querySelectorAll<HTMLElement>(":scope > [data-route]"));
      if (widthsRef.current === null && chips.length === listed.length && chips.every((chip) => chip.offsetWidth > 0)) {
        widthsRef.current = chips.map((chip) => chip.offsetWidth);
      }
      const widths = widthsRef.current;
      const more = list.querySelector<HTMLElement>(":scope > [data-more]");
      if (widths === null || !more || list.clientWidth === 0) return;
      const style = getComputedStyle(list);
      const gap = parseFloat(style.columnGap) || 0;
      const available = list.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
      const row = more.offsetWidth + MORE_DIGIT_ROOM_PX;
      let shown = widths.length;
      let used = widths.reduce((sum, width) => sum + width + gap, 0);
      while (shown > 1 && used + row > available) {
        shown -= 1;
        used -= widths[shown]! + gap;
      }
      setFit(shown);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [overflows, listed.length]);

  const shown = listed.slice(0, overflows ? fit : listed.length);
  const more = count - shown.length;
  return (
    <ul ref={listRef} aria-label={label} className="flex flex-wrap gap-1 pl-[1.125rem]">
      {shown.map((route) => (
        <RouteChip key={route.key} route={route} markRole={markRole} />
      ))}
      {more > 0 ? (
        <li
          data-more=""
          title={routes.slice(shown.length).map((route) => route.label).join(", ") || undefined}
          className="inline-flex items-center whitespace-nowrap px-1 py-0.5 text-2xs leading-tight text-muted-foreground"
        >
          +{more} more
        </li>
      ) : null}
    </ul>
  );
}

/**
 * Bridge routes as a grouped list: one group per route type in published
 * `bridgeTierQuality` order (the tier dot keys the shared tier hue; an
 * opaque or unestablished tier is hatched, never red), each with its route
 * count, any Control role tags, and its chain chips, the first eight then
 * "+N more". A role every route in the group shares is tagged once on the
 * group; in a mixed group a limiting route's chip is outlined and a
 * diagnostic one dashed. The home chain carries a house glyph. A limiting input no route
 * carries (`bandLimiting`) is stated once above the groups.
 *
 * No proportion bar: per-chain supply is not published, so routes are
 * listed rather than sized, and the caption says so. The DOM is the data
 * surface (lists of named routes); the dots are decorative.
 */
export function DeploymentRouteGroups({
  routes,
  totals,
  ariaLabel,
  caveats = [],
  bandLimiting,
  className,
}: DeploymentRouteGroupsProps) {
  if (routes.length === 0) return null;
  const groups = groupDeploymentRoutes(routes);
  const countsAreTotals = totals !== undefined && groups.every((group) => Object.hasOwn(totals, group.label));
  const caption = [CAPTION, ...caveats.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}.`)].join(" ");

  return (
    <div role="group" aria-label={ariaLabel} className={cn("min-w-0 space-y-3", className)}>
      {bandLimiting !== undefined ? (
        <p data-band-limiting="" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-foreground">
          <ControlRoleTag role="limiting" size="compact" />
          <span>{bandLimiting}: applies to every route</span>
        </p>
      ) : null}
      <ul className="space-y-3">
        {groups.map((group) => {
          const count = countsAreTotals ? totals[group.label]! : group.routes.length;
          const roles = (["limiting", "diagnostic"] as const).filter((role) =>
            group.routes.some((route) => route.role === role),
          );
          // One shared role is said once by the header tag; a mixed group marks each chip.
          const markRole = !(roles.length === 1 && group.routes.every((route) => route.role === roles[0]));
          return (
            <li key={group.key} data-route-group={group.key} className="min-w-0 space-y-1.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span aria-hidden="true" className={cn("h-2.5 w-2.5 shrink-0 rounded-full", group.dotClass)} />
                <span className="text-xs font-medium text-foreground">{group.label}</span>
                <span data-group-count="" className="pharos-numeric text-xs text-muted-foreground">
                  {count}
                  <span className="sr-only">{count === 1 ? " route" : " routes"}</span>
                </span>
                {roles.map((role) => (
                  <ControlRoleTag key={role} role={role} size="compact" />
                ))}
              </div>
              <RouteChipList label={`${group.label} routes`} routes={group.routes} count={count} markRole={markRole} />
            </li>
          );
        })}
      </ul>
      {routes.length > 1 ? (
        <p data-route-caption="" className="text-2xs leading-snug text-muted-foreground">{caption}</p>
      ) : null}
    </div>
  );
}
