interface CsvColumn<T> {
  header: string;
  accessor: (row: T, index: number) => string | number | null;
}

export function downloadCsv<T>(
  data: T[],
  columns: CsvColumn<T>[],
  filename: string,
): void {
  const header = columns.map((c) => c.header).join(",");
  const rows = data.map((row, rowIndex) =>
    columns
      .map((c) => {
        const val = c.accessor(row, rowIndex);
        if (val === null || val === undefined) return "";
        const str = String(val);
        return str.includes(",") || str.includes('"') || str.includes("\n")
          ? `"${str.replace(/"/g, '""')}"`
          : str;
      })
      .join(","),
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
