// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlacklistTable } from "@/components/blacklist-table";
import { BlacklistDetailEventFeed } from "@/components/stablecoin-detail/blacklist-detail-event-feed";
import type { BlacklistEvent } from "@shared/types";
import type * as DownloadModule from "@/lib/exports/download";

const { downloadMock, useBlacklistEventsPageMock } = vi.hoisted(() => ({
  downloadMock: vi.fn(),
  useBlacklistEventsPageMock: vi.fn(),
}));

vi.mock("@/lib/exports/download", async (importOriginal) => ({
  ...(await importOriginal<typeof DownloadModule>()),
  triggerFileDownload: downloadMock,
}));

vi.mock("@/hooks/use-blacklist-events", () => ({
  useBlacklistEventsPage: useBlacklistEventsPageMock,
}));

vi.mock("next/link", async () => {
  // vi.mock factories are hoisted above static imports, so the shared mock must load here.
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

afterEach(() => {
  downloadMock.mockReset();
  useBlacklistEventsPageMock.mockReset();
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

const amountMatrix: Array<{ event: BlacklistEvent; expected: string }> = [
  {
    event: { ...event, id: "usd", amountUsdAtEvent: 123.45, amountNative: 999, amountSource: "event", amountStatus: "resolved" },
    expected: "$123.45",
  },
  {
    event: { ...event, id: "native", amountNative: 125.5, amountUsdAtEvent: null, amountSource: "event", amountStatus: "resolved" },
    expected: "125.5 USDT",
  },
  {
    event: { ...event, id: "zero-unknown", amountNative: 0, amountUsdAtEvent: null, amountSource: "unavailable", amountStatus: "provider_failed" },
    expected: "provider failed",
  },
  {
    event: { ...event, id: "zero-destroy", eventType: "destroy", amountNative: 0, amountUsdAtEvent: null, amountSource: "event", amountStatus: "resolved" },
    expected: "0 USDT",
  },
  {
    event: { ...event, id: "pending", amountNative: null, amountUsdAtEvent: null, amountSource: "unavailable", amountStatus: "recoverable_pending" },
    expected: "pending recovery",
  },
  {
    event: { ...event, id: "unavailable", amountNative: null, amountUsdAtEvent: null, amountSource: "unavailable", amountStatus: "permanently_unavailable" },
    expected: "unavailable",
  },
];

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

  it("keeps the amount/status matrix identical across desktop, mobile, and detail renderers", () => {
    const events = amountMatrix.map((entry) => entry.event);
    const ledger = renderTable(events);

    for (const { expected } of amountMatrix) {
      expect(within(ledger.container).getAllByText(expected).length).toBeGreaterThanOrEqual(2);
    }
    expect(within(ledger.container).queryByText("N/A")).toBeNull();
    expect(within(ledger.container).queryByText("\u2014")).toBeNull();
    ledger.unmount();

    useBlacklistEventsPageMock.mockReturnValue({
      data: { events, total: events.length },
      isLoading: false,
      isError: false,
    });
    const detail = render(<BlacklistDetailEventFeed symbol="USDT" />);

    for (const { expected } of amountMatrix) {
      expect(within(detail.container).getAllByText(expected).length).toBeGreaterThan(0);
    }
  });

  it("exports provenance and contract metadata columns in CSV", () => {
    renderTable();

    fireEvent.click(screen.getByRole("button", { name: /export current page csv/i }));

    expect(downloadMock).toHaveBeenCalledTimes(1);
    const csv = downloadMock.mock.calls[0][0].join("").replace(/^\uFEFF/, "");
    const [header, row] = csv.trim().split("\n").map((line: string) =>
      Array.from(line.matchAll(/(?:^|,)("(?:[^"]|"")*"|[^,]*)/g), (match) =>
        match[1].replace(/^"|"$/g, "").replaceAll('""', '"')),
    );
    const values = Object.fromEntries(header.map((name: string, index: number) => [name, row[index]]));
    expect(values).toMatchObject({
      "Amount Source": "current_balance_snapshot",
      "Amount Status": "provider_failed",
      "Contract Address": "0xdac17f958d2ee523a2206206994597c13d831ec7",
      "Config Key": "ethereum-0xdac17f958d2ee523a2206206994597c13d831ec7",
      "Event Signature": "AddedBlackList(address)",
      "Event Topic0": "0x42e160154868087d6bfdc0ca23d96a1c1cfa32f1b72ba9ba27b69b98a0d819dc",
    });
  });
});
