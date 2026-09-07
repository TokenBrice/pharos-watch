import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTweetText, postDigestTweet, TwitterPostError } from "../twitter";
import { mockFetch } from "@shared/test-utils/mock-fetch";

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

  it("prefers the declared lead ticker when it appears, while keeping one cashtag", () => {
    const result = buildTweetText(
      "",
      "$USDT fell while USDC rose and USDT stabilized.",
      undefined,
      null,
      { leadSignalId: "liquidity:usdc", coins: ["USDC", "USDT"] },
    );

    expect(result).toBe("USDT fell while $USDC rose and USDT stabilized.");
    expect(result.match(/\$(?:USDT|USDC)/g)).toEqual(["$USDC"]);
  });

  it("falls back to the first ticker when the declared lead is absent from the text", () => {
    expect(buildTweetText(
      "",
      "USDT fell while USDC rose.",
      undefined,
      null,
      { leadSignalId: "liquidity:dai", coins: ["DAI"] },
    )).toBe("$USDT fell while USDC rose.");
  });

  it("includes edition number in tweet when provided", () => {
    const result = buildTweetText("Calm Drift", "PSI held firm at 94.1.", 22);
    expect(result).toBe("Calm Drift (#22)\n\nPSI held firm at 94.1.");
  });

  it("keeps the complete map hook inside the 270-character boundary", () => {
    const hook = "See the map.";
    const result = buildTweetText(
      "Calm Drift",
      "USDT moved through a deliberately long digest sentence ".repeat(8),
      22,
      hook,
    );

    expect(result.length).toBeLessThanOrEqual(270);
    expect(result.endsWith(hook)).toBe(true);
    expect(result).toContain("$USDT");
    expect(result.match(/\$/g)).toHaveLength(1);
    expect(result.slice(0, -hook.length).trimEnd()).toMatch(/\w…$/u);
  });

  it("does not truncate a representative long edition with the shortened map hook", () => {
    const text = "USD1 took in $4.00M and fxUSD $3.02M while rwaUSDi shed $3.96M, all three pinning intensity at 100 on flows worth a rounding error; if the Bank Run Gauge slips to negative 10, this stops being noise.";
    const hook = "See the map.";
    const result = buildTweetText("Small Flows, Maxed Signals", text, 188, hook);

    expect(result).toBe(`Small Flows, Maxed Signals (#188)\n\n$USD1 took in $4.00M and fxUSD $3.02M while rwaUSDi shed $3.96M, all three pinning intensity at 100 on flows worth a rounding error; if the Bank Run Gauge slips to negative 10, this stops being noise.\n\n${hook}`);
    expect(result).toHaveLength(249);
  });

  it("does not append a map hook when captions are unavailable", () => {
    expect(buildTweetText("Daily Digest", "USDT held steady.", 42, null)).not.toContain("See the map.");
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

    await expect(postDigestTweet("Daily Digest", "Daily Digest: USDT outpaced USDC.", creds)).resolves.toMatchObject({
      tweetId: "1",
    });

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

  it("uploads and attaches the daily Safety Score map", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("pharos.watch/safety-scores/map.png")) {
        return new Response(image, { status: 200, headers: { "Content-Type": "image/png" } });
      }
      if (url === "https://upload.twitter.com/1.1/media/upload.json") {
        expect(init?.body).toBeInstanceOf(FormData);
        expect((init?.headers as Record<string, string>).Authorization).toContain('oauth_consumer_key="api-key"');
        return new Response(JSON.stringify({ media_id_string: "1234567890123456789" }), { status: 200 });
      }
      const payload = JSON.parse(String(init?.body));
      expect(payload.media).toEqual({ media_ids: ["1234567890123456789"] });
      expect(payload.text).toContain("See the map.");
      return new Response(JSON.stringify({ data: { id: "1" } }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(postDigestTweet(
      "Daily Digest",
      "USDT held steady.",
      creds,
      42,
      "https://pharos.watch/safety-scores/map.png?date=2026-08-21",
      "See the map.",
    )).resolves.toEqual({ tweetId: "1", mediaAttached: true });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("retries the map upload once, then aborts the tweet instead of degrading to text-only", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("pharos.watch/safety-scores/map.png")) {
        return new Response("missing", { status: 404 });
      }
      throw new Error("tweet endpoint must not be reached when the map upload fails");
    });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(postDigestTweet(
      "Daily Digest",
      "USDT held steady.",
      creds,
      null,
      "https://pharos.watch/safety-scores/map.png?date=2026-08-21",
      "See the map.",
    )).rejects.toThrow("HTTP 404");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("throws when the Twitter API responds with an error", async () => {
    const response = new Response("denied", { status: 403 });
    mockFetch([{ match: () => true, respond: () => response }]);

    await expect(postDigestTweet("", "USDT stumbled against USDC.", creds)).rejects.toThrow("Twitter API 403: denied");
    expect(response.bodyUsed).toBe(true);
  });

  it("classifies a clear 4xx rejection as definitively retryable", async () => {
    mockFetch([{ match: () => true, respond: () => new Response('{"detail":"denied"}', { status: 403 }) }]);

    const error = await postDigestTweet("", "USDT stumbled.", creds).catch((caught) => caught);
    expect(error).toBeInstanceOf(TwitterPostError);
    expect(error).toMatchObject({ twitterDeliveryFailureKind: "definitive_failure", statusCode: 403 });
  });

  it("classifies network and ambiguous 5xx failures as execution unknown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("connection reset");
    }));
    const networkError = await postDigestTweet("", "USDT stumbled.", creds).catch((caught) => caught);
    expect(networkError).toMatchObject({ twitterDeliveryFailureKind: "execution_unknown", statusCode: null });

    mockFetch([{ match: () => true, respond: () => new Response("upstream timeout", { status: 503 }) }]);
    const serverError = await postDigestTweet("", "USDT stumbled.", creds).catch((caught) => caught);
    expect(serverError).toMatchObject({ twitterDeliveryFailureKind: "execution_unknown", statusCode: 503 });
  });
});
