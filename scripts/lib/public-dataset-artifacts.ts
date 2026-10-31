import { escapeCsvField } from "@shared/lib/csv";

export type DatasetVariant = "csv" | "json" | "ndjson";

/** Object values stay structured in JSON/NDJSON and are serialized as one JSON field in CSV; booleans stay native in JSON and render as `true`/`false` in CSV. */
type DatasetValue = string | number | boolean | null | Readonly<Record<string, unknown>>;

export interface DatasetColumn<T> {
  header: string;
  accessor: (row: T, index: number) => DatasetValue;
}

export interface PublicDatasetMetadata {
  endpoint: string;
  asOfISO: string;
  sourceUrl: (variant: DatasetVariant) => string;
  methodologyLabel: string;
  freshnessContract?: string;
  sourceGeneration?: string;
  sourceObservationStartedAtISO?: string;
  windowSnapshotAsOfISO?: string;
  metadataStatus?: "approximated";
  metadataNote?: string;
  /**
   * Optional versioned display projection; JSON in `_meta` and the NDJSON
   * preamble only. The CSV keeps its pre-wave single `#` preamble so Sheets
   * `IMPORTDATA` users still read a table, not a comment block.
   */
  displayProjection?: Readonly<Record<string, unknown>>;
}

const FRESHNESS_CONTRACT = "point-in-time sample; not guaranteed to track production freshness";

function metadataFields(metadata: PublicDatasetMetadata, variant: DatasetVariant) {
  return {
    endpoint: metadata.endpoint,
    asOfISO: metadata.asOfISO,
    sourceUrl: metadata.sourceUrl(variant),
    methodologyLabel: metadata.methodologyLabel,
    freshnessContract: metadata.freshnessContract ?? FRESHNESS_CONTRACT,
    ...(metadata.sourceGeneration ? { sourceGeneration: metadata.sourceGeneration } : {}),
    ...(metadata.sourceObservationStartedAtISO ? { sourceObservationStartedAtISO: metadata.sourceObservationStartedAtISO } : {}),
    ...(metadata.windowSnapshotAsOfISO ? { windowSnapshotAsOfISO: metadata.windowSnapshotAsOfISO } : {}),
    ...(metadata.metadataStatus ? { metadataStatus: metadata.metadataStatus, metadataNote: metadata.metadataNote } : {}),
    ...(metadata.displayProjection ? { displayProjection: metadata.displayProjection } : {}),
  };
}

function preambleLine(metadata: PublicDatasetMetadata, variant: DatasetVariant): string {
  const suffix = metadata.metadataStatus ? ` | Metadata: ${metadata.metadataStatus}${metadata.metadataNote ? ` (${metadata.metadataNote})` : ""}` : "";
  const provenance = metadata.sourceGeneration
    ? ` | Source generation: ${metadata.sourceGeneration} | Source observation started: ${metadata.sourceObservationStartedAtISO} | Window snapshot as of: ${metadata.windowSnapshotAsOfISO}`
    : "";
  return `Pharos pharos.watch | Endpoint: ${metadata.endpoint} | As of: ${metadata.asOfISO} | URL: ${metadata.sourceUrl(variant)} | Methodology: ${metadata.methodologyLabel} | Freshness: ${metadata.freshnessContract ?? FRESHNESS_CONTRACT}${provenance}${suffix}`;
}

export function buildPublicDatasetArtifacts<T>({
  rows,
  columns,
  metadata,
}: {
  rows: T[];
  columns: DatasetColumn<T>[];
  metadata: PublicDatasetMetadata;
}): { csv: string; json: string; ndjson: string } {
  const projectedRows: Array<Record<string, DatasetValue>> = rows.map((row, rowIndex) =>
    Object.fromEntries(columns.map((column) => [column.header, column.accessor(row, rowIndex)])),
  );
  const csvRows = projectedRows.map((row) => columns.map((column) => {
    const value = row[column.header];
    return escapeCsvField(value !== null && typeof value === "object" ? JSON.stringify(value) : value);
  }).join(","));

  return {
    csv: [
      `# ${preambleLine(metadata, "csv")}`,
      columns.map((column) => column.header).join(","),
      ...csvRows,
    ].join("\n") + "\n",
    json: JSON.stringify(
      {
        _meta: { ...metadataFields(metadata, "json"), rowCount: rows.length },
        rows: projectedRows,
      },
      null,
      2,
    ) + "\n",
    ndjson: [
      JSON.stringify({ _meta: metadataFields(metadata, "ndjson") }),
      ...projectedRows.map((row) => JSON.stringify(row)),
    ].join("\n") + "\n",
  };
}
