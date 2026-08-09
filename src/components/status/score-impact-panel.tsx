import { CLIENT_ACTIVE_META_BY_ID as ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import type { ClassificationWarning, ReserveDriftEntry, StatusResponse } from "@shared/types";
import { SummaryBadge } from "@/components/status/page-primitives";
import { cn } from "@/lib/utils";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { STATUS_PANEL_SHELL_CLASS } from "@/components/status/page-primitives";
import { STATUS_OK_PILL_CLASS } from "@/lib/status-dashboard-model";

interface ScoreImpactPanelProps {
  reserveComposition: StatusResponse["reserveComposition"];
  reserveDrift: ReserveDriftEntry[] | undefined;
  classificationWarnings: ClassificationWarning[] | undefined;
}

function getCoinLabel(coinId: string): string {
  const meta = ACTIVE_META_BY_ID.get(coinId);
  if (!meta) return coinId;
  return `${meta.symbol} · ${meta.name}`;
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function getDeltaClass(delta: number): string {
  if (delta >= 25) return "text-red-700 dark:text-red-400";
  if (delta >= 15) return "text-amber-700 dark:text-amber-400";
  return "text-muted-foreground";
}

export function ScoreImpactPanel({ reserveComposition, reserveDrift, classificationWarnings }: ScoreImpactPanelProps) {
  const driftRows = [...(reserveDrift ?? [])].sort((a, b) => b.delta - a.delta).slice(0, 6);
  const reserveInputHold =
    reserveComposition.status !== "healthy" ||
    reserveComposition.deferredCoins > 0 ||
    reserveComposition.runBudgetTruncated ||
    reserveComposition.writeTimeoutUncertain > 0;

  return (
    <section className={cn("rounded-xl p-4", STATUS_PANEL_SHELL_CLASS)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-base font-semibold tracking-tight text-foreground">Score impact monitor</h3>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Connects reserve-sync pressure to the score inputs operators see in report cards. This is not a new scoring
            rule; it shows where live reserve evidence is forcing conservative or divergent inputs.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <SummaryBadge
            label="Reserve input"
            value={reserveInputHold ? "conservative" : "clean"}
            className={
              reserveInputHold
                ? SEVERITY_TONE_CLASS.watch.pill
                : STATUS_OK_PILL_CLASS
            }
          />
          <SummaryBadge label="Score-grade" value={formatPct(reserveComposition.authoritativeFreshCoverageRatio)} />
          <SummaryBadge label="Drift rows" value={reserveDrift ? String(reserveDrift.length) : "Unknown"} />
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,0.45fr)]">
        <div className="overflow-hidden rounded-xl border border-border/60 bg-background/45">
          <div className="grid grid-cols-[minmax(0,1fr)_6rem_6rem_5rem] gap-3 border-b border-border/60 bg-muted/25 px-3 py-2 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
            <span>Coin</span>
            <span className="text-right">Live</span>
            <span className="text-right">Curated</span>
            <span className="text-right">Delta</span>
          </div>
          {driftRows.length > 0 ? (
            <div className="divide-y divide-border/55">
              {driftRows.map((entry) => (
                <div
                  key={entry.coinId}
                  className="grid grid-cols-[minmax(0,1fr)_6rem_6rem_5rem] gap-3 px-3 py-2 text-xs"
                >
                  <span className="min-w-0 truncate font-medium text-foreground">{getCoinLabel(entry.coinId)}</span>
                  <span className="text-right font-mono tabular-nums text-foreground">
                    {entry.liveCollateralScore.toFixed(1)}
                  </span>
                  <span className="text-right font-mono tabular-nums text-muted-foreground">
                    {entry.curatedCollateralScore.toFixed(1)}
                  </span>
                  <span className={cn("text-right font-mono tabular-nums", getDeltaClass(entry.delta))}>
                    {entry.delta.toFixed(1)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-3 py-4 text-sm text-muted-foreground">
              {reserveDrift
                ? "No live-vs-curated collateral drift is above the report-card watch threshold."
                : "Reserve drift payload is unavailable; no zero count is inferred."}
            </div>
          )}
        </div>

        <div className="space-y-3 rounded-xl border border-border/60 bg-background/45 p-3 text-xs">
          <div>
            <div className="text-sm font-medium text-foreground">Operator read</div>
            <p className="mt-1 leading-relaxed text-muted-foreground">
              {reserveInputHold
                ? "Safety Scores may look lower where score-grade reserve evidence is missing, deferred, or downgraded."
                : "Reserve evidence is score-grade; broad score downgrades are more likely from coin-specific inputs."}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="text-muted-foreground">Fresh</div>
              <div className="font-mono text-sm text-foreground">
                {formatPct(reserveComposition.freshCoverageRatio)}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Deferred</div>
              <div className="font-mono text-sm text-foreground">{reserveComposition.deferredCoins}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Degraded feeds</div>
              <div className="font-mono text-sm text-foreground">{reserveComposition.degradedCoins}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Classification warnings</div>
              <div className="font-mono text-sm text-foreground">
                {classificationWarnings ? classificationWarnings.length : "Unknown"}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
