export interface CsvColumn<T> {
  header: string;
  accessor: (row: T, index: number) => string | number | null;
}

const SPREADSHEET_FORMULA_PREFIX = /^[\t\r\n ]*[=+\-@]/;

function neutralizeSpreadsheetFormula(value: string): string {
  return SPREADSHEET_FORMULA_PREFIX.test(value) ? `'${value}` : value;
}

export function escapeCsvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const str = typeof value === "string" ? neutralizeSpreadsheetFormula(value) : String(value);
  return str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")
    ? `"${str.replace(/"/g, '""')}"`
    : str;
}

/** Build the header + escaped data rows shared by browser and script CSV builders. */
export function buildCsvBody<T>(data: T[], columns: CsvColumn<T>[]): string[] {
  const header = columns.map((c) => c.header).join(",");
  const rows = data.map((row, rowIndex) =>
    columns.map((c) => escapeCsvField(c.accessor(row, rowIndex))).join(","),
  );
  return [header, ...rows];
}

/** Build the CSV string (header + rows). Pure: no DOM access. */
export function buildCsv<T>(data: T[], columns: CsvColumn<T>[]): string {
  return buildCsvBody(data, columns).join("\n");
}
