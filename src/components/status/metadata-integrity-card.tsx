import { STATUS_RESERVE_DRIFT_THRESHOLD_POINTS } from "@shared/lib/status-thresholds";
import type { ClassificationWarning, ReserveDriftEntry, StatusSectionError } from "@shared/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LazyDetails } from "@/components/status/lazy-details";
import { getCoinLabel } from "@/components/status/page-primitives";

const INITIAL_WARNING_COUNT = 6;

function ReserveDriftRow({ entry }: { entry: ReserveDriftEntry }) {
  return (
    <div className="rounded-lg border border-border/60 p-3">
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
  );
}

function ClassificationWarningRow({ warning }: { warning: ClassificationWarning }) {
  return (
    <div className="rounded-lg border border-border/60 p-3">
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
  );
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
  const reserveDriftRows = reserveDrift ?? [];
  const classificationWarningRows = classificationWarnings ?? [];
  const reserveDriftShownCount = Math.min(reserveDriftRows.length, INITIAL_WARNING_COUNT);
  const classificationWarningShownCount = Math.min(classificationWarningRows.length, INITIAL_WARNING_COUNT);
  const hasReserveDrift = reserveDriftRows.length > 0;
  const hasClassificationWarnings = classificationWarningRows.length > 0;

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
            {hasReserveDrift ? (
              <p className="mt-1 text-xs font-medium text-foreground">
                {reserveDriftRows.length} warning{reserveDriftRows.length === 1 ? "" : "s"} (
                {reserveDriftShownCount} shown)
              </p>
            ) : null}
          </div>
          {hasReserveDrift ? (
            <div className="space-y-2">
              {reserveDriftRows.slice(0, INITIAL_WARNING_COUNT).map((entry) => (
                <ReserveDriftRow key={entry.coinId} entry={entry} />
              ))}
              {reserveDriftRows.length > INITIAL_WARNING_COUNT ? (
                <LazyDetails
                  summary={
                    <summary className="pharos-focus-ring flex min-h-11 cursor-pointer items-center rounded-md text-sm font-medium text-muted-foreground">
                      Show remaining {reserveDriftRows.length - INITIAL_WARNING_COUNT} warning
                      {reserveDriftRows.length - INITIAL_WARNING_COUNT === 1 ? "" : "s"}
                    </summary>
                  }
                >
                  <div className="space-y-2 pt-2">
                    {reserveDriftRows.slice(INITIAL_WARNING_COUNT).map((entry) => (
                      <ReserveDriftRow key={entry.coinId} entry={entry} />
                    ))}
                  </div>
                </LazyDetails>
              ) : null}
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
            {hasClassificationWarnings ? (
              <p className="mt-1 text-xs font-medium text-foreground">
                {classificationWarningRows.length} warning{classificationWarningRows.length === 1 ? "" : "s"} (
                {classificationWarningShownCount} shown)
              </p>
            ) : null}
          </div>
          {hasClassificationWarnings ? (
            <div className="space-y-2">
              {classificationWarningRows.slice(0, INITIAL_WARNING_COUNT).map((warning) => (
                <ClassificationWarningRow key={warning.coinId} warning={warning} />
              ))}
              {classificationWarningRows.length > INITIAL_WARNING_COUNT ? (
                <LazyDetails
                  summary={
                    <summary className="pharos-focus-ring flex min-h-11 cursor-pointer items-center rounded-md text-sm font-medium text-muted-foreground">
                      Show remaining {classificationWarningRows.length - INITIAL_WARNING_COUNT} warning
                      {classificationWarningRows.length - INITIAL_WARNING_COUNT === 1 ? "" : "s"}
                    </summary>
                  }
                >
                  <div className="space-y-2 pt-2">
                    {classificationWarningRows.slice(INITIAL_WARNING_COUNT).map((warning) => (
                      <ClassificationWarningRow key={warning.coinId} warning={warning} />
                    ))}
                  </div>
                </LazyDetails>
              ) : null}
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
