import type { DatasetFreshnessKey } from "../types/status/core";
import { getCronJobMeta } from "./cron-jobs";

type DatasetFreshnessDescriptor = {
  label: string;
  owners: readonly string[];
  cadenceOwners?: readonly string[];
};

/** Public dataset labels and producer cadence; private SQL evidence stays in the Worker. */
export const STATUS_DATASET_FRESHNESS: Record<DatasetFreshnessKey, DatasetFreshnessDescriptor> = {
  stablecoins: { label: "Stablecoins cache", owners: ["sync-stablecoins"] },
  blacklist: { label: "Blacklist sync", owners: ["sync-blacklist"] },
  mintBurn: {
    label: "Mint/burn sync",
    owners: ["sync-mint-burn", "sync-mint-burn-extended"],
    cadenceOwners: ["sync-mint-burn"],
  },
  supply: { label: "Supply history", owners: ["snapshot-supply"] },
  safetyGrades: { label: "Safety Score publication", owners: ["compute-safety-score-v9"] },
  yield: { label: "Yield data", owners: ["sync-yield-data"] },
  depegs: { label: "Depeg pipeline", owners: ["sync-stablecoins"] },
  dews: { label: "DEWS signals", owners: ["compute-dews"] },
  digest: { label: "Daily digest", owners: ["daily-digest"] },
};

export function getDatasetCadenceSec(key: DatasetFreshnessKey): number | null {
  const meta = STATUS_DATASET_FRESHNESS[key];
  const intervals = (meta.cadenceOwners ?? meta.owners)
    .map((owner) => getCronJobMeta(owner)?.intervalSec)
    .filter((interval): interval is number => interval != null);
  return intervals.length > 0 ? Math.min(...intervals) : null;
}
