import { TRACKED_STABLECOINS } from "../../../src/lib/stablecoins";

export interface TwitterCreds {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

/** RFC 3986 percent-encode (stricter than encodeURIComponent for OAuth). */
function encode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Build and return an OAuth 1.0a Authorization header for a given request.
 * Uses crypto.subtle (available in Cloudflare Workers) for HMAC-SHA1.
 */
async function buildOAuthHeader(
  method: string,
  url: string,
  creds: TwitterCreds,
): Promise<string> {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };

  // Signature base string: sorted, encoded key=value pairs
  const paramString = Object.keys(oauthParams)
    .sort()
    .map((k) => `${encode(k)}=${encode(oauthParams[k])}`)
    .join("&");

  const baseString = [method.toUpperCase(), encode(url), encode(paramString)].join("&");
  const signingKey = `${encode(creds.apiSecret)}&${encode(creds.accessTokenSecret)}`;

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingKey),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sigBytes = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(baseString),
  );
  oauthParams.oauth_signature = btoa(
    String.fromCharCode(...new Uint8Array(sigBytes)),
  );

  return (
    "OAuth " +
    Object.keys(oauthParams)
      .sort()
      .map((k) => `${encode(k)}="${encode(oauthParams[k])}"`)
      .join(", ")
  );
}

/** Extract tracked stablecoin symbols mentioned in text, in order of appearance. */
export function extractCashtags(text: string): string[] {
  const symbols = [...new Set(TRACKED_STABLECOINS.map((s) => s.symbol))];
  const found: { sym: string; pos: number }[] = [];

  for (const sym of symbols) {
    // Whole-word, case-insensitive match
    const match = text.match(new RegExp(`\\b${sym}\\b`, "i"));
    if (match?.index != null) {
      found.push({ sym, pos: match.index });
    }
  }

  // Sort by position so cashtags appear in mention order
  return found.sort((a, b) => a.pos - b.pos).map((f) => f.sym);
}

/** Truncate text to fit within maxLen chars, breaking at a word boundary. */
function truncateToFit(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.lastIndexOf(" ", maxLen - 1);
  return (cut > 0 ? text.slice(0, cut) : text.slice(0, maxLen - 1)) + "…";
}

/** Build final tweet text: title + digest + cashtags, truncating text to fit 280 chars. */
export function buildTweetText(digestTitle: string, digestText: string): string {
  const MAX = 280;
  const tags = extractCashtags(digestText);
  const tagStr = tags.length > 0 ? `\n\n${tags.map((s) => `$${s}`).join(" ")}` : "";
  const titlePrefix = digestTitle ? `${digestTitle}\n\n` : "";
  const available = MAX - titlePrefix.length - tagStr.length;
  const fittedText = truncateToFit(digestText, available);
  return `${titlePrefix}${fittedText}${tagStr}`;
}

/** Post a single tweet using OAuth 1.0a. Throws on API error. */
async function postTweet(text: string, creds: TwitterCreds): Promise<void> {
  const url = "https://api.twitter.com/2/tweets";
  const authHeader = await buildOAuthHeader("POST", url, creds);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Twitter API ${res.status}: ${body.slice(0, 300)}`);
  }
}

/**
 * Build tweet text from digest and post it.
 * The caller is responsible for catching errors.
 */
export async function postDigestTweet(
  digestTitle: string,
  digestText: string,
  creds: TwitterCreds,
): Promise<void> {
  const tweetText = buildTweetText(digestTitle, digestText);
  await postTweet(tweetText, creds);
  console.log(`[twitter] Posted digest tweet (${tweetText.length} chars)`);
}
