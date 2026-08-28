// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlacklistTable } from "@/components/blacklist-table";
import type { BlacklistEvent } from "@shared/types";

const { downloadCsvMock } = vi.hoisted(() => ({
  downloadCsvMock: vi.fn(),
}));

vi.mock("@/lib/exports/csv", () => ({
  downloadCsv: downloadCsvMock,
}));

afterEach(() => {
  downloadCsvMock.mockReset();
});

const event = {
  id: "ethereum-0xtx-1",
  stablecoin: "USDT",
  chainId: "ethereum",
  chainName: "Ethereum",
  eventType: "blacklist",
  address: "0x1111111111111111111111111111111111111111",
  amountNative: 125,
  amountUsdAtEvent: null,
  amountSource: "current_balance_snapshot",
  amountStatus: "provider_failed",
  txHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
  blockNumber: 123,
  timestamp: 1_776_729_600,
  methodologyVersion: "3.99",
  contractAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7",
  configKey: "ethereum-0xdac17f958d2ee523a2206206994597c13d831ec7",
  eventSignature: "AddedBlackList(address)",
  eventTopic0: "0x42e160154868087d6bfdc0ca23d96a1c1cfa32f1b72ba9ba27b69b98a0d819dc",
  suppressionReason: null,
  explorerTxUrl: "https://etherscan.io/tx/0x2222",
  explorerAddressUrl: "https://etherscan.io/address/0x1111",
} satisfies BlacklistEvent;

function renderTable(events: BlacklistEvent[] = [event]) {
  return render(
    <BlacklistTable
      events={events}
      isLoading={false}
      page={1}
      pageSize={50}
      sortKey="date"
      sortDirection="desc"
      onSortChange={vi.fn()}
    />,
  );
}

describe("BlacklistTable", () => {
  it("renders amount provenance and unresolved status badges", () => {
    renderTable();

    expect(screen.getByTestId("freezewatch-events-table").getAttribute("data-table-id")).toBe(
      "freezewatch-events",
    );
    expect(screen.getAllByText("Snapshot").length).toBeGreaterThan(0);
    expect(screen.getAllByText("provider failed").length).toBeGreaterThan(0);
  });

  it("exports provenance and contract metadata columns in CSV", () => {
    renderTable();

    fireEvent.click(screen.getByRole("button", { name: /export current page csv/i }));

    expect(downloadCsvMock).toHaveBeenCalledTimes(1);
    expect(downloadCsvMock.mock.calls[0][0]).toEqual([event]);
    const [, columns] = downloadCsvMock.mock.calls[0];
    expect(columns.map((column: { header: string }) => column.header)).toEqual(
      expect.arrayContaining([
        "Amount Source",
        "Amount Status",
        "Contract Address",
        "Config Key",
        "Event Signature",
        "Event Topic0",
      ]),
    );
  });
});
