import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTweetText, postDigestTweet } from "../twitter";

const creds = {
  apiKey: "api-key",
  apiSecret: "api-secret",
  accessToken: "access-token",
  accessTokenSecret: "access-secret",
};

describe("twitter helpers", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", {
      randomUUID: () => "12345678-1234-1234-1234-1234567890ab",
      subtle: {
        importKey: vi.fn(async () => "key"),
        sign: vi.fn(async () => Uint8Array.from([1, 2, 3]).buffer),
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("builds tweet text with title stripping, first-mention cashtags, and truncation", () => {
    expect(
      buildTweetText(
        "Daily Digest",
        "Daily Digest: USDT held while usdt volume rose and USDC followed.",
      ),
    ).toBe("Daily Digest\n\n$USDT held while usdt volume rose and $USDC followed.");

    const longWord = buildTweetText("", "x".repeat(400));
    expect(longWord).toHaveLength(280);
    expect(longWord.endsWith("…")).toBe(true);
  });

  it("posts a digest tweet with an OAuth header", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const fetchSpy = vi.fn(
      async (_input: string | Request | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ data: { id: "1" } }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await postDigestTweet("Daily Digest", "Daily Digest: USDT outpaced USDC.", creds);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.twitter.com/2/tweets");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toContain('oauth_consumer_key="api-key"');
    expect((init?.headers as Record<string, string>).Authorization).toContain('oauth_nonce="123456781234123412341234567890ab"');
    expect((init?.headers as Record<string, string>).Authorization).toContain('oauth_signature="AQID"');
    expect((init?.headers as Record<string, string>).Authorization).toContain('oauth_timestamp="1700000000"');
    expect(JSON.parse(String(init?.body))).toEqual({
      text: "Daily Digest\n\n$USDT outpaced $USDC.",
    });
  });

  it("throws when the Twitter API responds with an error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 403 })));

    await expect(
      postDigestTweet("", "USDT stumbled against USDC.", creds),
    ).rejects.toThrow("Twitter API 403: denied");
  });
});
