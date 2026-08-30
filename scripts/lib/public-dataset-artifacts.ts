import { escapeCsvField } from "@shared/lib/csv";

export type DatasetVariant = "csv" | "json" | "ndjson";

export interface DatasetColumn<T> {
  header: string;
  accessor: (row: T, index: number) => string | number | null;
}

export interface PublicDatasetMetadata {
  endpoint: string;
  asOfISO: string;
  sourceUrl: (variant: DatasetVariant) => string;
  methodologyLabel: string;
  metadataStatus?: "approximated";
  metadataNote?: string;
}

const FRESHNESS_CONTRACT = "point-in-time sample; not guaranteed to track production freshness";

function metadataFields(metadata: PublicDatasetMetadata, variant: DatasetVariant) {
  return {
    endpoint: metadata.endpoint,
    asOfISO: metadata.asOfISO,
    sourceUrl: metadata.sourceUrl(variant),
    methodologyLabel: metadata.methodologyLabel,
    freshnessContract: FRESHNESS_CONTRACT,
    ...(metadata.metadataStatus ? { metadataStatus: metadata.metadataStatus, metadataNote: metadata.metadataNote } : {}),
  };
}

function preambleLine(metadata: PublicDatasetMetadata, variant: DatasetVariant): string {
  const suffix = metadata.metadataStatus ? ` | Metadata: ${metadata.metadataStatus}${metadata.metadataNote ? ` (${metadata.metadataNote})` : ""}` : "";
  return `Pharos pharos.watch | Endpoint: ${metadata.endpoint} | As of: ${metadata.asOfISO} | URL: ${metadata.sourceUrl(variant)} | Methodology: ${metadata.methodologyLabel} | Freshness: ${FRESHNESS_CONTRACT}${suffix}`;
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
  const projectedRows: Array<Record<string, string | number | null>> = rows.map((row, rowIndex) =>
    Object.fromEntries(columns.map((column) => [column.header, column.accessor(row, rowIndex)])),
  );
  const csvRows = projectedRows.map((row) => columns.map((column) => escapeCsvField(row[column.header])).join(","));

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
