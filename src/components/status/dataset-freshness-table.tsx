import { getCronJobMeta } from "@shared/lib/cron-jobs";
import { STATUS_CACHE_RATIO_THRESHOLDS } from "@shared/lib/status-thresholds";
import { getDatasetCadenceSec, STATUS_DATASET_FRESHNESS } from "@shared/lib/status-dataset-freshness";
import type { DatasetFreshnessKey } from "@shared/types/status/core";
import type { StatusResponse } from "@shared/types";
import { DataTableShell } from "@/components/data-table-shell";
import { TableCell, TableRow } from "@/components/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatElapsedSeconds } from "@shared/lib/format";
import { OPERATIONAL_PILL_CLASS } from "@/lib/status/dashboard-presentation";
import { StatusPill } from "./severity-pill";
import { defineStatusColumns, Timestamp } from "./page-primitives";

const DATASET_FRESHNESS_COLUMNS = defineStatusColumns([
  ["domain", "Domain"], ["updated", "Updated"], ["age", "Age"], ["cadence", "Cadence"],
  ["grace-basis", "Grace Basis"], ["writers", "Writers"], ["band", "Band"],
]);

// Band heuristics reuse the canonical default availability ratios over the
// writer cadence: 8× cadence (= 4× the displayed grace basis) and 12× cadence
// (= 6× the basis). Thresholds are intentionally generous — only flag truly
// overdue pipelines.
function getBand(
  ageSeconds: number | null,
  cadenceSec: number | null,
): {
  label: string;
  className: string;
} {
  if (ageSeconds == null) {
    return {
      label: "unavailable",
      className: OPERATIONAL_PILL_CLASS.unknown,
    };
  }
  if (cadenceSec == null) {
    return {
      label: "unknown",
      className: OPERATIONAL_PILL_CLASS.unknown,
    };
  }
  if (ageSeconds > cadenceSec * STATUS_CACHE_RATIO_THRESHOLDS.stale) {
    return {
      label: "late",
      className: OPERATIONAL_PILL_CLASS.error,
    };
  }
  if (ageSeconds > cadenceSec * STATUS_CACHE_RATIO_THRESHOLDS.degraded) {
    return {
      label: "aging",
      className: OPERATIONAL_PILL_CLASS.warning,
    };
  }
  return {
    label: "on time",
    className: OPERATIONAL_PILL_CLASS.ok,
  };
}

export function DatasetFreshnessTable({
  datasetFreshness,
  nowSeconds,
}: {
  datasetFreshness: StatusResponse["datasetFreshness"];
  nowSeconds: number;
}) {
  const rows = (Object.keys(STATUS_DATASET_FRESHNESS) as DatasetFreshnessKey[]).map((key) => {
    const meta = STATUS_DATASET_FRESHNESS[key];
    const clock = datasetFreshness[key];
    const reason = datasetFreshness.unavailableReasons?.[key];
    const updatedAt = reason == null && clock != null && Number.isFinite(clock)
      && Number.isFinite(nowSeconds) && clock <= nowSeconds ? clock : null;
    const ageSeconds = updatedAt != null ? nowSeconds - updatedAt : null;
    const cadenceSec = getDatasetCadenceSec(key);
    const expectedFreshnessSec = cadenceSec != null ? cadenceSec * 2 : null;
    const owners = meta.owners.map((owner) => getCronJobMeta(owner)?.label ?? owner).join(", ");

    return {
      key,
      label: meta.label,
      updatedAt,
      unavailableReason: reason ?? (clock == null ? "missing-timestamp"
        : !Number.isFinite(clock) || !Number.isFinite(nowSeconds) ? "invalid-timestamp"
        : clock > nowSeconds ? "future-timestamp" : null),
      ageSeconds,
      owners,
      cadenceSec,
      expectedFreshnessSec,
      band: getBand(ageSeconds, cadenceSec),
    };
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h3" className="text-base">Pipeline freshness</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="mb-3 text-xs text-muted-foreground">
          Informational view of the last successful writer evaluation per domain. Cadence is the writer schedule; grace
          basis is the reference window for this table, with green status held through 4x that basis and late after 6x
          so quiet event-backed domains follow writer health rather than the most recent emitted event.
        </div>
        <DataTableShell
          tableId="dataset-freshness"
          testId="dataset-freshness-table"
          columns={DATASET_FRESHNESS_COLUMNS}
          chrome="content"
          density="compact"
          tableProps={{ "aria-label": "Pipeline freshness" }}
          caption="Pipeline freshness by data domain"
          captionClassName="sr-only"
          headerClassName=""
          headerRowClassName="border-b text-left text-muted-foreground"
        >
          {rows.map((row) => (
              <TableRow key={row.key} className="border-b last:border-0">
                <TableCell className="py-2">{row.label}</TableCell>
                <TableCell className="py-2 text-xs text-muted-foreground">
                  <Timestamp epochSec={row.updatedAt} nowSec={nowSeconds} />
                </TableCell>
                <TableCell className="py-2">
                  {row.ageSeconds != null ? formatElapsedSeconds(row.ageSeconds) : "—"}
                </TableCell>
                <TableCell className="py-2">
                  {row.cadenceSec != null ? formatElapsedSeconds(row.cadenceSec) : "—"}
                </TableCell>
                <TableCell className="py-2">
                  {row.expectedFreshnessSec != null ? formatElapsedSeconds(row.expectedFreshnessSec) : "—"}
                </TableCell>
                <TableCell className="py-2 text-xs text-muted-foreground">{row.owners}</TableCell>
                <TableCell className="py-2" title={row.unavailableReason ?? undefined}>
                  <StatusPill className={row.band.className}>
                    {row.band.label}
                  </StatusPill>
                </TableCell>
              </TableRow>
            ))}
        </DataTableShell>
      </CardContent>
    </Card>
  );
}
