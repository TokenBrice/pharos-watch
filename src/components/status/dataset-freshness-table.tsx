import { getCronJobMeta } from "@shared/lib/cron-jobs";
import type { StatusResponse } from "@shared/types";
import { DataTableShell, type DataTableColumn } from "@/components/data-table-shell";
import { TableCell, TableRow } from "@/components/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatElapsedSeconds } from "@shared/lib/format";
import { StatusPill } from "./severity-pill";

type DatasetKey = keyof StatusResponse["datasetFreshness"];

const DATASET_FRESHNESS_COLUMNS: readonly DataTableColumn[] = [
  { id: "domain", label: "Domain", className: "pb-2 font-medium" },
  { id: "updated", label: "Updated", className: "pb-2 font-medium" },
  { id: "age", label: "Age", className: "pb-2 font-medium" },
  { id: "cadence", label: "Cadence", className: "pb-2 font-medium" },
  { id: "grace-basis", label: "Grace Basis", className: "pb-2 font-medium" },
  { id: "writers", label: "Writers", className: "pb-2 font-medium" },
  { id: "band", label: "Band", className: "pb-2 font-medium" },
];

const DATASET_META: Record<
  DatasetKey,
  {
    label: string;
    owners: readonly string[];
    expectedOwners?: readonly string[];
  }
> = {
  stablecoins: { label: "Stablecoins cache", owners: ["sync-stablecoins"] },
  blacklist: { label: "Blacklist sync", owners: ["sync-blacklist"] },
  mintBurn: {
    label: "Mint/burn sync",
    owners: ["sync-mint-burn", "sync-mint-burn-extended"],
    expectedOwners: ["sync-mint-burn"],
  },
  supply: { label: "Supply history", owners: ["snapshot-supply"] },
  safetyGrades: { label: "Safety grade history", owners: ["snapshot-safety-grade-history"] },
  yield: { label: "Yield data", owners: ["sync-yield-data"] },
  depegs: { label: "Depeg pipeline", owners: ["sync-stablecoins"] },
  dews: { label: "DEWS signals", owners: ["compute-dews"] },
  digest: { label: "Daily digest", owners: ["daily-digest"] },
};

function getExpectedFreshnessSec(owners: readonly string[]): number | null {
  const cadenceSec = getCadenceSec(owners);
  return cadenceSec == null ? null : cadenceSec * 2;
}

function getCadenceSec(owners: readonly string[]): number | null {
  const intervals = owners
    .map((owner) => getCronJobMeta(owner)?.intervalSec)
    .filter((interval): interval is number => interval != null);
  if (intervals.length === 0) return null;
  return Math.min(...intervals);
}

// Band heuristics: "on time" = age ≤ 4× expected (2× intervalSec),
// "aging" = 4× expected < age ≤ 6× expected, "late" = age > 6× expected.
// Thresholds are intentionally generous — only flag truly overdue pipelines.
function getBand(
  ageSeconds: number | null,
  expectedFreshnessSec: number | null,
): {
  label: string;
  className: string;
} {
  if (ageSeconds == null) {
    return {
      label: "missing",
      className: "bg-muted text-muted-foreground",
    };
  }
  if (expectedFreshnessSec == null) {
    return {
      label: "unknown",
      className: "bg-muted text-muted-foreground",
    };
  }
  if (ageSeconds > expectedFreshnessSec * 6) {
    return {
      label: "late",
      className: "bg-red-500/15 text-red-700 dark:text-red-400",
    };
  }
  if (ageSeconds > expectedFreshnessSec * 4) {
    return {
      label: "aging",
      className: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    };
  }
  return {
    label: "on time",
    className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  };
}

export function DatasetFreshnessTable({
  datasetFreshness,
  nowSeconds,
}: {
  datasetFreshness: StatusResponse["datasetFreshness"];
  nowSeconds: number;
}) {
  const rows = (Object.keys(DATASET_META) as DatasetKey[]).map((key) => {
    const meta = DATASET_META[key];
    const updatedAt = datasetFreshness[key];
    const ageSeconds = updatedAt != null ? Math.max(0, nowSeconds - updatedAt) : null;
    const cadenceSec = getCadenceSec(meta.expectedOwners ?? meta.owners);
    const expectedFreshnessSec = getExpectedFreshnessSec(meta.expectedOwners ?? meta.owners);
    const owners = meta.owners.map((owner) => getCronJobMeta(owner)?.label ?? owner).join(", ");

    return {
      key,
      label: meta.label,
      updatedAt,
      ageSeconds,
      owners,
      cadenceSec,
      expectedFreshnessSec,
      band: getBand(ageSeconds, expectedFreshnessSec),
    };
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h3" className="text-base">Pipeline Freshness</CardTitle>
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
                  {row.updatedAt ? new Date(row.updatedAt * 1000).toLocaleString() : "—"}
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
                <TableCell className="py-2">
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
