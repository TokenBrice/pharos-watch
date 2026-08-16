import { logWorkerEventArgs } from "./structured-log";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { drainResponseBody } from "./response-body";

export interface TwitterCreds {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

const TRACKED_CASHTAG_SYMBOLS = [...new Set(ACTIVE_STABLECOINS.map((stablecoin) => stablecoin.symbol))];
// eslint-disable-next-line security/detect-non-literal-regexp -- tracked symbols are curated and bounded to whole-word matches.
const TRACKED_CASHTAG_PATTERN = new RegExp(`\\b(?:${TRACKED_CASHTAG_SYMBOLS.join("|")})\\b`, "i");

/** RFC 3986 percent-encode (stricter than encodeURIComponent for OAuth). */
function encode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Build and return an OAuth 1.0a Authorization header for a given request.
 * Uses crypto.subtle (available in Cloudflare Workers) for HMAC-SHA1.
 */
async function buildOAuthHeader(method: string, url: string, creds: TwitterCreds): Promise<string> {
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
  const sigBytes = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(baseString));
  oauthParams.oauth_signature = btoa(String.fromCharCode(...new Uint8Array(sigBytes)));

  return (
    "OAuth " +
    Object.keys(oauthParams)
      .sort()
      .map((k) => `${encode(k)}="${encode(oauthParams[k])}"`)
      .join(", ")
  );
}

/** Inject a `$` cashtag prefix on the earliest tracked-ticker mention in text.
 *  Twitter rejects posts containing more than one cashtag, so only the first
 *  match wins; subsequent ticker mentions remain plain text. */
function injectCashtags(text: string): string {
  return text.replace(TRACKED_CASHTAG_PATTERN, (match) => `$${match.toUpperCase()}`);
}

/** Truncate text to fit within maxLen chars, breaking at a word boundary. */
function truncateToFit(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.lastIndexOf(" ", maxLen - 1);
  return (cut > 0 ? text.slice(0, cut) : text.slice(0, maxLen - 1)) + "…";
}

/** Build final tweet text: title + digest with inline cashtags injected on first ticker mention.
 *  The LLM prompt targets 270 combined chars for title+text, leaving ~10 chars headroom
 *  for cashtag `$` prefixes injected below. truncateToFit is a safety net for overflow. */
export function buildTweetText(digestTitle: string, digestText: string, editionNumber?: number | null): string {
  const MAX = 270;
  const editionTag = editionNumber ? ` (#${editionNumber})` : "";
  const titlePrefix = digestTitle ? `${digestTitle}${editionTag}\n\n` : "";
  // Strip title if the LLM accidentally repeated it at the start of the text
  let text = digestText;
  if (digestTitle && text.toLowerCase().startsWith(digestTitle.toLowerCase())) {
    text = text
      .slice(digestTitle.length)
      .replace(/^[\s\n:–—-]+/, "")
      .trim();
  }
  const available = MAX - titlePrefix.length;
  const tagged = injectCashtags(text);
  const fittedText = truncateToFit(tagged, available);
  if (fittedText !== tagged) {
    logWorkerEventArgs("lib", "warn", `[twitter] Tweet truncated: ${tagged.length} chars -> ${fittedText.length} chars (limit ${available})`);
  }
  return `${titlePrefix}${fittedText}`;
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

  await drainResponseBody(res);
}

/**
 * Build tweet text from digest and post it.
 * The caller is responsible for catching errors.
 */
export async function postDigestTweet(
  digestTitle: string,
  digestText: string,
  creds: TwitterCreds,
  editionNumber?: number | null,
): Promise<void> {
  const tweetText = buildTweetText(digestTitle, digestText, editionNumber);
  await postTweet(tweetText, creds);
  logWorkerEventArgs("lib", "info", `[twitter] Posted digest tweet (${tweetText.length} chars)`);
}
