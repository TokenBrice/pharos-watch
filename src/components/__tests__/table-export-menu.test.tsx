// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
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

  it("renders three export actions plus the trigger", () => {
    render(
      <TableExportMenu
        data={ROWS}
        columns={COLUMNS}
        filename="stablecoins"
        endpoint="stablecoins"
        methodologyLabel="safety-score v7.25"
      />,
    );

    expect(screen.getByRole("button", { name: "Download CSV" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download NDJSON" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy as Markdown" })).toBeTruthy();
  });

  it("dispatches the CSV writer with the data, columns, filename, and preamble", () => {
    render(
      <TableExportMenu
        data={ROWS}
        columns={COLUMNS}
        filename="stablecoins"
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
      asOfISO: "2026-05-16T12:00:00.000Z",
      methodologyLabel: "safety-score v7.25",
    });
    expect(typeof preamble.sourceUrl).toBe("string");
  });

  it("does not dispatch export writers while disabled", () => {
    render(
      <TableExportMenu
        data={ROWS}
        columns={COLUMNS}
        filename="stablecoins"
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

  it("dispatches the NDJSON writer when the NDJSON action fires", () => {
    render(
      <TableExportMenu
        data={ROWS}
        columns={COLUMNS}
        filename="stablecoins"
        endpoint="stablecoins"
        methodologyLabel="safety-score v7.25"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Download NDJSON" }));

    expect(downloadNdjsonWithPreambleMock).toHaveBeenCalledTimes(1);
    expect(downloadCsvWithPreambleMock).not.toHaveBeenCalled();
  });

  it("dispatches the markdown writer and shows the copied state", async () => {
    render(
      <TableExportMenu
        data={ROWS}
        columns={COLUMNS}
        filename="stablecoins"
        endpoint="stablecoins"
        methodologyLabel="safety-score v7.25"
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy as Markdown" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(copyMarkdownWithPreambleMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Copied!")).toBeTruthy();
  });

  it("restarts feedback expiry after a second copy and clears it on unmount", async () => {
    const baseline = vi.getTimerCount();
    const { unmount } = render(
      <TableExportMenu data={ROWS} columns={COLUMNS} filename="stablecoins"
        endpoint="stablecoins" methodologyLabel="safety-score v7.25" />,
    );
    const copy = async () => {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Copy as Markdown" }));
      });
    };
    await copy();
    act(() => vi.advanceTimersByTime(1500));
    await copy();
    act(() => vi.advanceTimersByTime(1999));
    expect(screen.getByText("Copied!")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("Copied!")).toBeNull();
    expect(screen.getByText("Export")).toBeTruthy();
    await copy();
    expect(vi.getTimerCount()).toBe(baseline + 1);
    unmount();
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it("does not schedule feedback when pending copy completes after unmount", async () => {
    let finish!: (ok: boolean) => void;
    copyMarkdownWithPreambleMock.mockReturnValueOnce(new Promise<boolean>((resolve) => { finish = resolve; }));
    const { unmount } = render(
      <TableExportMenu data={ROWS} columns={COLUMNS} filename="stablecoins"
        endpoint="stablecoins" methodologyLabel="safety-score v7.25" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy as Markdown" }));
    unmount();
    const baseline = vi.getTimerCount();
    await act(async () => { finish(true); });
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it("shows a failure label when markdown copy is rejected", async () => {
    copyMarkdownWithPreambleMock.mockResolvedValueOnce(false);

    render(
      <TableExportMenu
        data={ROWS}
        columns={COLUMNS}
        filename="stablecoins"
        endpoint="stablecoins"
        methodologyLabel="safety-score v7.25"
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy as Markdown" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Copy failed")).toBeTruthy();
  });
});
