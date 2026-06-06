import { escapeCsvField, type CsvColumn } from "@/lib/exports/csv";

export function downloadCsv<T>(
  data: T[],
  columns: CsvColumn<T>[],
  filename: string,
): void {
  const header = columns.map((c) => c.header).join(",");
  const rows = data.map((row, rowIndex) =>
    columns.map((c) => escapeCsvField(c.accessor(row, rowIndex))).join(","),
  );
  const csv = [header, ...rows].join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filename}-${new Date().toISOString().split("T")[0]}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
