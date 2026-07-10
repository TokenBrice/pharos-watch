import { STATUS_RESERVE_DRIFT_THRESHOLD_POINTS } from "@shared/lib/status-thresholds";
import { CLIENT_ACTIVE_META_BY_ID as ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import type { ClassificationWarning, ReserveDriftEntry, StatusSectionError } from "@shared/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function getCoinLabel(coinId: string): string {
  const meta = ACTIVE_META_BY_ID.get(coinId);
  if (!meta) return coinId;
  return `${meta.symbol} · ${meta.name}`;
}

export function MetadataIntegrityCard({
  reserveDrift,
  classificationWarnings,
  reserveDriftError,
  classificationWarningsError,
}: {
  reserveDrift: ReserveDriftEntry[] | undefined;
  classificationWarnings: ClassificationWarning[] | undefined;
  reserveDriftError?: StatusSectionError;
  classificationWarningsError?: StatusSectionError;
}) {
  const hasReserveDrift = (reserveDrift?.length ?? 0) > 0;
  const hasClassificationWarnings = (classificationWarnings?.length ?? 0) > 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle as="h3" className="text-base">Metadata Integrity Watchlist</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-3">
          <div>
            <h3 className="text-sm font-medium">Curated vs live reserve drift</h3>
            <p className="text-xs text-muted-foreground">
              Flags coins where comparable live reserve mixes shift collateral quality by more than{" "}
              {STATUS_RESERVE_DRIFT_THRESHOLD_POINTS} points versus curated metadata.
            </p>
          </div>
          {hasReserveDrift ? (
            <div className="space-y-2">
              {reserveDrift?.slice(0, 6).map((entry) => (
                <div key={entry.coinId} className="rounded-lg border border-border/60 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm font-medium">{getCoinLabel(entry.coinId)}</div>
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                      {entry.delta.toFixed(1)}pt drift
                    </span>
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    live {entry.liveCollateralScore.toFixed(1)} vs curated {entry.curatedCollateralScore.toFixed(1)}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-border/60 p-3 text-sm text-muted-foreground">
              {reserveDriftError
                ? `Reserve drift loader failed: ${reserveDriftError.message}`
                : reserveDrift
                  ? `No reserve-score drift above the ${STATUS_RESERVE_DRIFT_THRESHOLD_POINTS}-point watch threshold.`
                  : "Reserve drift payload is unavailable; no zero count is inferred."}
            </div>
          )}
        </div>

        <div className="space-y-3">
          <div>
            <h3 className="text-sm font-medium">Classification warnings</h3>
            <p className="text-xs text-muted-foreground">
              Decentralized classifications with centralized custody exposure above the 50% watch threshold.
            </p>
          </div>
          {hasClassificationWarnings ? (
            <div className="space-y-2">
              {classificationWarnings?.slice(0, 6).map((warning) => (
                <div key={warning.coinId} className="rounded-lg border border-border/60 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm font-medium">{getCoinLabel(warning.coinId)}</div>
                    <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-medium text-red-700 dark:text-red-400">
                      {warning.centralizedCustodyPct}% custody
                    </span>
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    governance {warning.governance} · threshold {warning.threshold}%
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-border/60 p-3 text-sm text-muted-foreground">
              {classificationWarningsError
                ? `Classification warning loader failed: ${classificationWarningsError.message}`
                : classificationWarnings
                  ? "No governance classification warnings are active."
                  : "Classification warnings payload is unavailable; no zero count is inferred."}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
