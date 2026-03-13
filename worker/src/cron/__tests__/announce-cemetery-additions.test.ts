import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetCache = vi.fn();
const mockSetCache = vi.fn();
const mockSendToChat = vi.fn();
const mockShouldAttemptFetch = vi.fn();
const mockRecordOutcome = vi.fn();

vi.mock("@shared/lib/dead-stablecoins", () => ({
  DEAD_STABLECOINS: [
    {
      name: "Palm USD",
      symbol: "PUSD",
      pegCurrency: "USD",
      causeOfDeath: "liquidity-drain",
      deathDate: "2026-01",
      peakMcap: 26_000_000,
      epitaph: "$2.8B promised. $81K left",
      obituary: "Palm USD obituary",
      sourceUrl: "https://example.com/pusd",
      sourceLabel: "Example",
    },
    {
      name: "Angle EURA",
      symbol: "EURA",
      pegCurrency: "EUR",
      causeOfDeath: "abandoned",
      deathDate: "2026-03",
      peakMcap: 200_000_000,
      epitaph: "DeFi's first Euro, last out",
      obituary: "Angle EURA obituary",
      sourceUrl: "https://example.com/eura",
      sourceLabel: "Example",
    },
    {
      name: "Angle USDA",
      symbol: "USDA",
      pegCurrency: "USD",
      causeOfDeath: "abandoned",
      deathDate: "2026-03",
      epitaph: "Late arrival, early exit",
      obituary: "Angle USDA obituary",
      sourceUrl: "https://example.com/usda",
      sourceLabel: "Example",
    },
  ],
}));

vi.mock("../../lib/db-cache", () => ({
  getCache: mockGetCache,
  setCache: mockSetCache,
}));

vi.mock("../../lib/telegram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/telegram")>();
  return {
    ...actual,
    sendToChat: mockSendToChat,
  };
});

vi.mock("../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: mockShouldAttemptFetch,
  recordOutcome: mockRecordOutcome,
}));

const { announceCemeteryAdditions, CEMETERY_FOOTERS } = await import("../announce-cemetery-additions");

describe("announceCemeteryAdditions", () => {
  beforeEach(() => {
    mockGetCache.mockReset();
    mockSetCache.mockReset();
    mockSendToChat.mockReset();
    mockShouldAttemptFetch.mockReset();
    mockRecordOutcome.mockReset();
    mockSetCache.mockResolvedValue(undefined);
    mockSendToChat.mockResolvedValue({
      ok: true,
      blocked: false,
      retryable: false,
      permanentFailure: false,
      statusCode: 200,
      errorClass: null,
      delivery: "sent",
    });
    mockShouldAttemptFetch.mockResolvedValue(true);
    mockRecordOutcome.mockResolvedValue(undefined);
  });

  it("seeds the cemetery snapshot on first run without posting", async () => {
    mockGetCache.mockResolvedValueOnce(null);

    const result = await announceCemeteryAdditions({} as D1Database, "bot-token", "@pharoswatch");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      snapshotSeeded: boolean;
      reason: string;
    };

    expect(result.itemCount).toBe(0);
    expect(metadata).toMatchObject({
      snapshotSeeded: true,
      reason: "first-run",
    });
    expect(mockRecordOutcome).toHaveBeenCalledWith({}, "telegram-api", true);
    expect(mockSendToChat).not.toHaveBeenCalled();
    expect(mockSetCache).toHaveBeenCalledTimes(1);
    expect(mockSetCache.mock.calls[0][1]).toBe("telegram:cemetery-snapshot");
  });

  it("posts one consolidated message for EURA and USDA with epitaphs and a rotating footer", async () => {
    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "telegram:cemetery-snapshot") {
        return {
          value: JSON.stringify(["PUSD|2026-01|palm usd"]),
          updatedAt: 1_778_500_000,
        };
      }
      if (key === "telegram:cemetery-footer-index") {
        return {
          value: "8",
          updatedAt: 1_778_500_000,
        };
      }
      return null;
    });

    const result = await announceCemeteryAdditions({} as D1Database, "bot-token", "@pharoswatch");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      sent: boolean;
      symbols: string[];
      footer: string;
    };
    const html = mockSendToChat.mock.calls[0][1] as string;

    expect(result.itemCount).toBe(2);
    expect(metadata).toMatchObject({
      sent: true,
      symbols: ["EURA", "USDA"],
      footer: CEMETERY_FOOTERS[8],
    });
    expect(mockSendToChat).toHaveBeenCalledTimes(1);
    expect(mockSendToChat.mock.calls[0][0]).toBe("@pharoswatch");
    expect(mockSendToChat.mock.calls[0][3]).toEqual({ disableWebPagePreview: true });
    expect(html).toContain("<b>🪦 2 stablecoins have fallen!</b>");
    expect(html).toContain("<code>EURA</code> Angle EURA");
    expect(html).toContain("<i>DeFi's first Euro, last out</i>");
    expect(html).toContain("<code>USDA</code> Angle USDA");
    expect(html).toContain("<i>Late arrival, early exit</i>");
    expect(html).toContain("Cause of death: Abandoned");
    expect(html).toContain("Died: 2026-03");
    expect(html).toContain("Peak mcap: $200.00M");
    expect(html).toContain(CEMETERY_FOOTERS[8]);
    expect(html).toContain('<a href="https://pharos.watch/cemetery/">Enter the cemetery →</a>');
    expect(mockSetCache).toHaveBeenCalledTimes(2);
    expect(mockRecordOutcome).toHaveBeenCalledWith({}, "telegram-api", true);
    expect(mockSetCache.mock.calls[0]).toEqual([
      {},
      "telegram:cemetery-snapshot",
      JSON.stringify([
        "PUSD|2026-01|palm usd",
        "EURA|2026-03|angle eura",
        "USDA|2026-03|angle usda",
      ]),
    ]);
    expect(mockSetCache.mock.calls[1]).toEqual([
      {},
      "telegram:cemetery-footer-index",
      "9",
    ]);
  });

  it("leaves the snapshot untouched when Telegram delivery fails", async () => {
    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "telegram:cemetery-snapshot") {
        return {
          value: JSON.stringify(["PUSD|2026-01|palm usd"]),
          updatedAt: 1_778_500_000,
        };
      }
      if (key === "telegram:cemetery-footer-index") {
        return {
          value: "0",
          updatedAt: 1_778_500_000,
        };
      }
      return null;
    });
    mockSendToChat.mockResolvedValue({
      ok: false,
      blocked: false,
      retryable: true,
      permanentFailure: false,
      statusCode: 500,
      errorClass: "server_error",
      delivery: "retryable_failure",
    });

    const result = await announceCemeteryAdditions({} as D1Database, "bot-token", "@pharoswatch");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      sent: boolean;
      delivery: string;
      symbols: string[];
    };

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    expect(metadata).toMatchObject({
      sent: false,
      delivery: "retryable_failure",
      symbols: ["EURA", "USDA"],
    });
    expect(mockRecordOutcome).toHaveBeenCalledWith({}, "telegram-api", false);
    expect(mockSetCache).not.toHaveBeenCalled();
  });
});
