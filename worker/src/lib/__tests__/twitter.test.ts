import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTweetText, postDigestTweet } from "../twitter";
import { mockFetch } from "../../test-helpers/__shared/mock-fetch";

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

  it("builds tweet text with title stripping, single earliest-mention cashtag, and truncation", () => {
    // Twitter rejects posts with >1 cashtag, so only the earliest ticker match gets the `$` prefix.
    expect(buildTweetText("Daily Digest", "Daily Digest: USDT held while usdt volume rose and USDC followed.")).toBe(
      "Daily Digest\n\n$USDT held while usdt volume rose and USDC followed.",
    );
    // Lowercase first mention is normalized to canonical uppercase.
    expect(buildTweetText("", "usdc traded above usdt today.")).toBe("$USDC traded above usdt today.");

    const longWord = buildTweetText("", "x".repeat(400));
    expect(longWord).toHaveLength(270);
    expect(longWord.endsWith("…")).toBe(true);
  });

  it("includes edition number in tweet when provided", () => {
    const result = buildTweetText("Calm Drift", "PSI held firm at 94.1.", 22);
    expect(result).toBe("Calm Drift (#22)\n\nPSI held firm at 94.1.");
  });

  it("omits edition number when null or undefined", () => {
    expect(buildTweetText("Calm Drift", "PSI held firm.", null)).toBe("Calm Drift\n\nPSI held firm.");
    expect(buildTweetText("Calm Drift", "PSI held firm.")).toBe("Calm Drift\n\nPSI held firm.");
  });

  it("posts a digest tweet with an OAuth header", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const response = new Response(JSON.stringify({ data: { id: "1" } }), { status: 201 });
    const fetchSpy = mockFetch([{ match: () => true, respond: () => response }]);

    await postDigestTweet("Daily Digest", "Daily Digest: USDT outpaced USDC.", creds);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.twitter.com/2/tweets");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toContain('oauth_consumer_key="api-key"');
    expect((init?.headers as Record<string, string>).Authorization).toContain(
      'oauth_nonce="123456781234123412341234567890ab"',
    );
    expect((init?.headers as Record<string, string>).Authorization).toContain('oauth_signature="AQID"');
    expect((init?.headers as Record<string, string>).Authorization).toContain('oauth_timestamp="1700000000"');
    expect(JSON.parse(String(init?.body))).toEqual({
      text: "Daily Digest\n\n$USDT outpaced USDC.",
    });
    expect(response.bodyUsed).toBe(true);
  });

  it("throws when the Twitter API responds with an error", async () => {
    const response = new Response("denied", { status: 403 });
    mockFetch([{ match: () => true, respond: () => response }]);

    await expect(postDigestTweet("", "USDT stumbled against USDC.", creds)).rejects.toThrow("Twitter API 403: denied");
    expect(response.bodyUsed).toBe(true);
  });
});
