import { getCronJobMeta } from "@shared/lib/cron-jobs";
import type { StatusResponse } from "@shared/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatAge } from "./format";

type DatasetKey = keyof StatusResponse["datasetFreshness"];

const DATASET_META: Record<DatasetKey, { label: string; owners: readonly string[] }> = {
  stablecoins: { label: "Stablecoins cache", owners: ["sync-stablecoins"] },
  blacklist: { label: "Blacklist events", owners: ["sync-blacklist"] },
  mintBurn: { label: "Mint/burn events", owners: ["sync-mint-burn", "sync-mint-burn-extended"] },
  supply: { label: "Supply history", owners: ["snapshot-supply"] },
  yield: { label: "Yield data", owners: ["sync-yield-data"] },
  depegs: { label: "Depeg events", owners: ["sync-stablecoins"] },
  dews: { label: "DEWS signals", owners: ["compute-dews"] },
  digest: { label: "Daily digest", owners: ["daily-digest"] },
};

function getExpectedFreshnessSec(owners: readonly string[]): number | null {
  const intervals = owners
    .map((owner) => getCronJobMeta(owner)?.intervalSec)
    .filter((interval): interval is number => interval != null);
  if (intervals.length === 0) return null;
  return Math.min(...intervals) * 2;
}

function getBand(ageSeconds: number | null, expectedFreshnessSec: number | null): {
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
  if (ageSeconds > expectedFreshnessSec * 1.5) {
    return {
      label: "late",
      className: "bg-red-500/15 text-red-700 dark:text-red-400",
    };
  }
  if (ageSeconds > expectedFreshnessSec) {
    return {
      label: "aging",
      className: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    };
  }
  return {
    label: "on time",
    className: "bg-green-500/15 text-green-700 dark:text-green-400",
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
    const expectedFreshnessSec = getExpectedFreshnessSec(meta.owners);
    const owners = meta.owners
      .map((owner) => getCronJobMeta(owner)?.label ?? owner)
      .join(", ");

    return {
      key,
      label: meta.label,
      updatedAt,
      ageSeconds,
      owners,
      expectedFreshnessSec,
      band: getBand(ageSeconds, expectedFreshnessSec),
    };
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Dataset Freshness</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="mb-3 text-xs text-muted-foreground">
          Informational view of the last dataset write per domain. Expected uses 2x the shortest owning cron cadence.
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th scope="col" className="pb-2 font-medium">Dataset</th>
                <th scope="col" className="pb-2 font-medium">Updated</th>
                <th scope="col" className="pb-2 font-medium">Age</th>
                <th scope="col" className="pb-2 font-medium">Expected</th>
                <th scope="col" className="pb-2 font-medium">Writer</th>
                <th scope="col" className="pb-2 font-medium">Band</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-b last:border-0">
                  <td className="py-2">{row.label}</td>
                  <td className="py-2 text-xs text-muted-foreground">
                    {row.updatedAt ? new Date(row.updatedAt * 1000).toLocaleString() : "—"}
                  </td>
                  <td className="py-2">{row.ageSeconds != null ? formatAge(row.ageSeconds) : "—"}</td>
                  <td className="py-2">{row.expectedFreshnessSec != null ? formatAge(row.expectedFreshnessSec) : "—"}</td>
                  <td className="py-2 text-xs text-muted-foreground">{row.owners}</td>
                  <td className="py-2">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${row.band.className}`}>
                      {row.band.label}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
