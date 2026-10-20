// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  downloadCsvWithPreambleMock,
  downloadNdjsonWithPreambleMock,
  copyMarkdownWithPreambleMock,
} = vi.hoisted(() => ({
  downloadCsvWithPreambleMock: vi.fn(),
  downloadNdjsonWithPreambleMock: vi.fn(),
  copyMarkdownWithPreambleMock: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/exports/csv", () => ({
  downloadCsvWithPreamble: downloadCsvWithPreambleMock,
}));
vi.mock("@/lib/exports/ndjson", () => ({
  downloadNdjsonWithPreamble: downloadNdjsonWithPreambleMock,
}));
vi.mock("@/lib/exports/markdown", () => ({
  copyMarkdownWithPreamble: copyMarkdownWithPreambleMock,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: ReactNode;
    onSelect?: () => void;
  }) => <button onClick={onSelect}>{children}</button>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { TableExportMenu } from "@/components/table-export-menu";

interface Row {
  name: string;
}

const ROWS: Row[] = [{ name: "USDC" }];
const COLUMNS = [{ header: "Name", accessor: (row: Row) => row.name }];
const SOURCE_AS_OF_ISO = "2026-05-16T06:00:00.000Z";

describe("TableExportMenu", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-16T12:00:00.000Z"));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    downloadCsvWithPreambleMock.mockReset();
    downloadNdjsonWithPreambleMock.mockReset();
    copyMarkdownWithPreambleMock.mockReset().mockResolvedValue(true);
  });


  it("dispatches the CSV writer with the data, columns, filename, and preamble", () => {
    render(
      <TableExportMenu
        data={ROWS}
        columns={COLUMNS}
        filename="stablecoins"
        asOfISO={SOURCE_AS_OF_ISO}
        endpoint="stablecoins"
        methodologyLabel="safety-score v7.25"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));

    expect(downloadCsvWithPreambleMock).toHaveBeenCalledTimes(1);
    const [data, columns, filename, preamble] = downloadCsvWithPreambleMock.mock.calls[0]!;
    expect(data).toBe(ROWS);
    expect(columns).toBe(COLUMNS);
    expect(filename).toBe("stablecoins");
    expect(preamble).toMatchObject({
      endpoint: "stablecoins",
      asOfISO: SOURCE_AS_OF_ISO,
      methodologyLabel: "safety-score v7.25",
    });
    expect(typeof preamble.sourceUrl).toBe("string");
  });

  it("forwards mixed and unknown producer generations unchanged to every export format", () => {
    const sourceGenerations = { stablecoins: SOURCE_AS_OF_ISO, reportCards: null, pegSummary: "2026-05-16T05:00:00.000Z" };
    render(<TableExportMenu data={ROWS} columns={COLUMNS} filename="screener" asOfISO="unknown"
      endpoint="screener" methodologyLabel="mixed-source export" sourceGenerations={sourceGenerations} />);
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    fireEvent.click(screen.getByRole("button", { name: "Download NDJSON" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy as Markdown" }));
    for (const preamble of [
      downloadCsvWithPreambleMock.mock.calls[0]?.[3],
      downloadNdjsonWithPreambleMock.mock.calls[0]?.[3],
      copyMarkdownWithPreambleMock.mock.calls[0]?.[2],
    ]) {
      expect(preamble).toMatchObject({ asOfISO: "unknown", sourceGenerations });
      expect(preamble.sourceGenerations.reportCards).toBeNull();
    }
  });

  it("does not dispatch export writers while disabled", () => {
    render(
      <TableExportMenu
        data={ROWS}
        columns={COLUMNS}
        filename="stablecoins"
        asOfISO={SOURCE_AS_OF_ISO}
        endpoint="stablecoins"
        methodologyLabel="safety-score v7.25"
        disabled
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    fireEvent.click(screen.getByRole("button", { name: "Download NDJSON" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy as Markdown" }));

    expect(downloadCsvWithPreambleMock).not.toHaveBeenCalled();
    expect(downloadNdjsonWithPreambleMock).not.toHaveBeenCalled();
    expect(copyMarkdownWithPreambleMock).not.toHaveBeenCalled();
  });

});
