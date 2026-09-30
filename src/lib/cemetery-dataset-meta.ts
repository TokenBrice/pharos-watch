import cemeteryDatasetExport from "../../public/datasets/stablecoin-cemetery.json";

/** Header fields of the published cemetery export read by the page (rows stay out of this module's surface). */
interface CemeteryDatasetHeader {
  schemaVersion: string;
  rowCount: number;
  updatedAt?: string | null;
  sourceChecksum: string;
  license: string;
}

const header = cemeteryDatasetExport as CemeteryDatasetHeader;
const CHECKSUM_PREFIX = "sha256:";
const SHORT_CHECKSUM_LENGTH = 8;

function shortChecksum(checksum: string): string {
  const hex = checksum.startsWith(CHECKSUM_PREFIX) ? checksum.slice(CHECKSUM_PREFIX.length) : checksum;
  return hex.slice(0, SHORT_CHECKSUM_LENGTH);
}

/** Download, citation and feed metadata for the public Stablecoin Cemetery dataset. */
export const CEMETERY_DATASET_META = {
  schemaVersion: header.schemaVersion,
  rowCount: header.rowCount,
  /** Latest `recordedAt` across rows (UTC `YYYY-MM-DD`); null when the export has none. */
  updatedAt: header.updatedAt ?? null,
  sourceChecksum: header.sourceChecksum,
  /** First 8 hex characters after `sha256:`. */
  sourceChecksumShort: shortChecksum(header.sourceChecksum),
  license: header.license,
  jsonUrl: "/datasets/stablecoin-cemetery.json",
  csvUrl: "/datasets/stablecoin-cemetery.csv",
  rssUrl: "/feed/cemetery.xml",
} as const;

export type CemeteryDatasetMeta = typeof CEMETERY_DATASET_META;

/** Items in the cemetery RSS feed (`/feed/cemetery.xml`): the most recent deaths. */
export const CEMETERY_FEED_MAX_ITEMS = 50;
