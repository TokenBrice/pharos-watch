import { formatCurrency } from "@shared/lib/format";
import type { LiquidityRouteFilter } from "@/app/liquidity/model";
import {
  OTHER_ROUTE_COLOR,
  type LiquidityExitRouteItem,
  type LiquidityExitRouteModel,
  type LiquidityExitRouteTailEntry,
} from "@/components/liquidity/exit-route-model";
import { cn } from "@/lib/utils";

/** Tail routes named one by one before the rest fold into a counted remainder. */
const LEDGER_TAIL_LISTED = 6;
/** Doors and lanes are drawn at 0.78 opacity; the ledger matches them exactly. */
const ROUTE_FILL_OPACITY = 0.78;

interface LedgerSegment {
  key: string;
  label: string;
  valueUsd: number;
  colorHex: string;
}

function LedgerRow({
  title,
  kind,
  routes,
  tail,
  activeRouteFilter,
  onRouteFilterChange,
}: {
  title: string;
  kind: "protocol" | "chain";
  routes: readonly LiquidityExitRouteItem[];
  tail: readonly LiquidityExitRouteTailEntry[];
  activeRouteFilter?: LiquidityRouteFilter | null;
  onRouteFilterChange?: (filter: LiquidityRouteFilter | null) => void;
}) {
  const named = routes.filter((route) => !route.isOther);
  const listedTail = tail.slice(0, LEDGER_TAIL_LISTED);
  const restTail = tail.slice(LEDGER_TAIL_LISTED);
  const restUsd = restTail.reduce((sum, entry) => sum + entry.valueUsd, 0);
  const tailUsd = tail.reduce((sum, entry) => sum + entry.valueUsd, 0);
  const segments: LedgerSegment[] = [
    ...named.map((route) => ({ key: route.key, label: route.label, valueUsd: route.valueUsd, colorHex: route.colorHex })),
    ...listedTail.map((entry) => ({ ...entry, colorHex: OTHER_ROUTE_COLOR })),
    ...(restUsd > 0
      ? [{ key: "_rest", label: `${restTail.length} more`, valueUsd: restUsd, colorHex: OTHER_ROUTE_COLOR }]
      : []),
  ];
  const total = segments.reduce((sum, segment) => sum + segment.valueUsd, 0);
  if (total <= 0) return null;

  const toggleRoute = (key: string, label: string) => {
    if (!onRouteFilterChange) return;
    const isSame = activeRouteFilter?.kind === kind && activeRouteFilter.key === key;
    onRouteFilterChange(isSame ? null : { kind, key, label });
  };

  return (
    <div className="grid gap-x-6 gap-y-2 lg:grid-cols-[6.5rem_minmax(0,1fr)]">
      <p className="text-sm font-medium text-muted-foreground lg:-mt-0.5">{title}</p>
      <div className="min-w-0 space-y-2.5">
        <div
          className="flex h-2 w-full gap-px overflow-hidden rounded-full"
          role="img"
          aria-label={`${title}: ${segments.map((segment) => `${segment.label} ${formatCurrency(segment.valueUsd)}`).join(", ")}`}
        >
          {segments.map((segment) => (
            <span
              key={segment.key}
              className="h-full shrink-0"
              title={`${segment.label}: ${formatCurrency(segment.valueUsd)}`}
              style={{
                width: `${(segment.valueUsd / total) * 100}%`,
                backgroundColor: segment.colorHex,
                opacity: ROUTE_FILL_OPACITY,
              }}
            />
          ))}
        </div>
        <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
          {named.map((route) => {
            const isActive = activeRouteFilter?.kind === kind && activeRouteFilter.key === route.key;
            const inner = (
              <>
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: route.colorHex, opacity: ROUTE_FILL_OPACITY }}
                  aria-hidden="true"
                />
                <span>{route.label}</span>
                <span className="pharos-numeric text-xs text-muted-foreground">{formatCurrency(route.valueUsd)}</span>
              </>
            );
            return (
              <li key={route.key} className="inline-flex items-center">
                {onRouteFilterChange ? (
                  <button
                    type="button"
                    aria-pressed={isActive}
                    onClick={() => toggleRoute(route.key, route.label)}
                    className={cn(
                      "pharos-focus-ring inline-flex items-center gap-1.5 rounded-sm transition-colors hover:text-foreground",
                      isActive ? "font-semibold text-foreground underline underline-offset-4" : "",
                    )}
                  >
                    {inner}
                  </button>
                ) : (
                  <span className="inline-flex items-center gap-1.5">{inner}</span>
                )}
              </li>
            );
          })}
          {tailUsd > 0 ? (
            <li className="inline-flex items-center">
              {onRouteFilterChange ? (
                <button
                  type="button"
                  aria-pressed={activeRouteFilter?.kind === kind && activeRouteFilter.key === "_other-routes"}
                  onClick={() => toggleRoute("_other-routes", "Other routes")}
                  className={cn(
                    "pharos-focus-ring inline-flex items-center gap-1.5 rounded-sm transition-colors hover:text-foreground",
                    activeRouteFilter?.kind === kind && activeRouteFilter.key === "_other-routes"
                      ? "font-semibold text-foreground underline underline-offset-4"
                      : "",
                  )}
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: OTHER_ROUTE_COLOR, opacity: ROUTE_FILL_OPACITY }}
                    aria-hidden="true"
                  />
                  <span>Other routes</span>
                  <span className="pharos-numeric text-xs text-muted-foreground">{formatCurrency(tailUsd)}</span>
                </button>
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: OTHER_ROUTE_COLOR, opacity: ROUTE_FILL_OPACITY }}
                    aria-hidden="true"
                  />
                  <span>Other routes</span>
                  <span className="pharos-numeric text-xs text-muted-foreground">{formatCurrency(tailUsd)}</span>
                </span>
              )}
            </li>
          ) : null}
        </ul>
        {listedTail.length > 0 ? (
          // Hidden below sm: the tail sentence costs a phone more scroll than it informs.
          <p className="pharos-meta hidden sm:block">
            <span className="text-foreground/80">Other routes:</span>{" "}
            {listedTail.map((entry, index) => (
              <span key={entry.key}>
                {index > 0 ? " · " : null}
                {entry.label} <span className="pharos-numeric">{formatCurrency(entry.valueUsd)}</span>
              </span>
            ))}
            {restTail.length > 0 ? (
              <span>
                {" · "}
                {restTail.length.toLocaleString("en-US")} more <span className="pharos-numeric">{formatCurrency(restUsd)}</span>
              </span>
            ) : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The hero's footer ledger: venue and chain mix as two thin bars in the map's
 * exact door and lane colours. It carries the exact dollar depth the map draws
 * as shares, and breaks "Other routes" into its named long tail.
 */
export function ExitRouteLedger({
  model,
  activeRouteFilter = null,
  onRouteFilterChange,
}: {
  model: LiquidityExitRouteModel;
  activeRouteFilter?: LiquidityRouteFilter | null;
  onRouteFilterChange?: (filter: LiquidityRouteFilter | null) => void;
}) {
  return (
    <div className="space-y-4" data-testid="exit-route-ledger">
      <LedgerRow
        title="Venue mix"
        kind="protocol"
        routes={model.protocolRoutes}
        tail={model.protocolTail}
        activeRouteFilter={activeRouteFilter}
        onRouteFilterChange={onRouteFilterChange}
      />
      <LedgerRow
        title="Chain mix"
        kind="chain"
        routes={model.chainRoutes}
        tail={model.chainTail}
        activeRouteFilter={activeRouteFilter}
        onRouteFilterChange={onRouteFilterChange}
      />
    </div>
  );
}
