import { toErrorMessage } from "@shared/lib/error-utils";
import { logWorkerEventArgs } from "./structured-log";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { drainResponseBody, readResponseTextBoundedWithSignal } from "./response-body";

export interface TwitterCreds {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

export class TwitterPostError extends Error {
  readonly twitterDeliveryFailureKind: "definitive_failure" | "execution_unknown";
  readonly statusCode: number | null;

  constructor(
    message: string,
    failureKind: "definitive_failure" | "execution_unknown",
    statusCode: number | null = null,
  ) {
    super(message);
    this.name = "TwitterPostError";
    this.twitterDeliveryFailureKind = failureKind;
    this.statusCode = statusCode;
  }
}

const TRACKED_CASHTAG_SYMBOLS = [...new Set(ACTIVE_STABLECOINS.map((stablecoin) => stablecoin.symbol))]
  .sort((left, right) => right.length - left.length);
const ESCAPED_TRACKED_CASHTAG_SYMBOLS = TRACKED_CASHTAG_SYMBOLS
  .map((symbol) => {
    let escaped = "";
    for (const character of symbol) {
      if ("\\^$.*+?()[]{}|".includes(character)) escaped += "\\";
      escaped += character;
    }
    return escaped;
  });
// eslint-disable-next-line security/detect-non-literal-regexp -- tracked symbols are curated and bounded to whole-word matches.
const TRACKED_CASHTAG_PATTERN = new RegExp(
  `(\\$)?\\b(${ESCAPED_TRACKED_CASHTAG_SYMBOLS.join("|")})\\b`,
  "gi",
);

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

interface CashtagMatch {
  end: number;
  start: number;
  symbol: string;
}

function parseDigestMetadata(value: unknown, allowNested = true): Record<string, unknown> | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const metadata = candidate as Record<string, unknown>;
  if (allowNested && metadata.meta !== undefined) {
    return parseDigestMetadata(metadata.meta, false) ?? metadata;
  }
  return metadata;
}

function trackedSymbol(value: string): string | null {
  const trimmed = value.trim();
  const normalized = (trimmed.startsWith("$") ? trimmed.slice(1) : trimmed).toUpperCase();
  return TRACKED_CASHTAG_SYMBOLS.find((symbol) => symbol.toUpperCase() === normalized) ?? null;
}

function preferredCashtagSymbols(value: unknown): string[] {
  const metadata = parseDigestMetadata(value);
  if (!metadata) return [];

  const symbols: string[] = [];
  const leadSignalId = metadata.leadSignalId;
  if (typeof leadSignalId === "string") {
    for (const token of leadSignalId.split(/[^A-Za-z0-9]+/)) {
      const symbol = token ? trackedSymbol(token) : null;
      if (symbol && !symbols.some((existing) => existing.toUpperCase() === symbol.toUpperCase())) {
        symbols.push(symbol);
      }
    }
  }

  const coins = metadata.coins;
  if (Array.isArray(coins)) {
    for (const coin of coins) {
      if (typeof coin !== "string") continue;
      const symbol = trackedSymbol(coin);
      if (symbol && !symbols.some((existing) => existing.toUpperCase() === symbol.toUpperCase())) {
        symbols.push(symbol);
      }
    }
  }
  return symbols;
}

/** Inject exactly one `$` cashtag, preferring the declared lead when it appears.
 *  Twitter rejects posts containing more than one cashtag, so all other
 *  tracked-ticker mentions (including pre-existing cashtags) remain plain text. */
function injectCashtags(text: string, digestMetadata?: unknown): string {
  const matches: CashtagMatch[] = [];
  for (const match of text.matchAll(TRACKED_CASHTAG_PATTERN)) {
    const start = match.index ?? 0;
    const fullMatch = match[0] ?? "";
    const symbol = match[2] ?? "";
    if (!symbol) continue;
    matches.push({
      start,
      end: start + fullMatch.length,
      symbol,
    });
  }
  if (matches.length === 0) return text;

  const preferred = preferredCashtagSymbols(digestMetadata);
  const preferredIndex = preferred
    .map((symbol) => matches.findIndex((match) => match.symbol.toUpperCase() === symbol.toUpperCase()))
    .find((index) => index >= 0);
  const selectedIndex = preferredIndex ?? 0;

  let output = "";
  let cursor = 0;
  matches.forEach((match, index) => {
    output += text.slice(cursor, match.start);
    const plainSymbol = match.symbol;
    output += index === selectedIndex ? `$${plainSymbol.toUpperCase()}` : plainSymbol;
    cursor = match.end;
  });
  return output + text.slice(cursor);
}

/** Truncate text to fit within maxLen chars, breaking at a word boundary. */
function truncateToFit(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.lastIndexOf(" ", maxLen - 1);
  return (cut > 0 ? text.slice(0, cut) : text.slice(0, maxLen - 1)) + "…";
}

/** Build final tweet text: title + digest with one inline cashtag on the declared
 *  lead ticker when available, otherwise on the first tracked mention. The LLM
 *  prompt targets 270 combined chars; truncateToFit remains the overflow safety net. */
export function buildTweetText(
  digestTitle: string,
  digestText: string,
  editionNumber?: number | null,
  mapHook?: string | null,
  digestMetadata?: unknown,
): string {
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
  const tagged = injectCashtags(text, digestMetadata);
  const mapSuffix = mapHook ? `\n\n${mapHook}` : "";
  const available = MAX - titlePrefix.length - mapSuffix.length;
  const fittedText = truncateToFit(tagged, available);
  if (fittedText !== tagged) {
    logWorkerEventArgs("lib", "warn", `[twitter] Tweet truncated: ${tagged.length} chars -> ${fittedText.length} chars (limit ${available})`);
  }
  return `${titlePrefix}${fittedText}${mapSuffix}`;
}

/** Post a single tweet using OAuth 1.0a. Throws with delivery ambiguity attached on API error. */
async function postTweet(text: string, creds: TwitterCreds, mediaId?: string): Promise<string> {
  const url = "https://api.twitter.com/2/tweets";
  let authHeader: string;
  try {
    authHeader = await buildOAuthHeader("POST", url, creds);
  } catch (error) {
    throw new TwitterPostError(`Twitter request signing failed before send: ${toErrorMessage(error)}`, "definitive_failure");
  }

  const requestSignal = AbortSignal.timeout(10_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        ...(mediaId ? { media: { media_ids: [mediaId] } } : {}),
      }),
      signal: requestSignal,
    });
  } catch (error) {
    throw new TwitterPostError(`Twitter tweet request failed with an unknown execution outcome: ${toErrorMessage(error)}`, "execution_unknown");
  }

  let body: string;
  try {
    body = await readResponseTextBoundedWithSignal(res, 16_384, requestSignal);
  } catch (error) {
    throw new TwitterPostError(`Twitter API ${res.status} response could not be read: ${toErrorMessage(error)}`, "execution_unknown", res.status);
  }

  if (!res.ok) {
    const clearRejection = res.status >= 400 && res.status < 500 && body.trim().length > 0;
    throw new TwitterPostError(
      `Twitter API ${res.status}: ${body.slice(0, 300) || "empty response"}`,
      clearRejection ? "definitive_failure" : "execution_unknown",
      res.status,
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch (error) {
    throw new TwitterPostError(`Twitter accepted the request but returned invalid JSON: ${toErrorMessage(error)}`, "execution_unknown", res.status);
  }
  const tweetId = (decoded as { data?: { id?: unknown } })?.data?.id;
  if (typeof tweetId !== "string" || tweetId.length === 0) {
    throw new TwitterPostError("Twitter accepted the request but omitted the tweet id", "execution_unknown", res.status);
  }
  return tweetId;
}

const TWITTER_MEDIA_UPLOAD_URL = "https://upload.twitter.com/1.1/media/upload.json";
const TWITTER_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

async function uploadTweetImage(imageUrl: string, creds: TwitterCreds): Promise<string> {
  const imageSignal = AbortSignal.timeout(10_000);
  const imageResponse = await fetch(imageUrl, { signal: imageSignal });
  if (!imageResponse.ok) {
    await drainResponseBody(imageResponse);
    throw new Error(`Safety map image HTTP ${imageResponse.status}`);
  }
  const contentType = imageResponse.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("image/png")) {
    await drainResponseBody(imageResponse);
    throw new Error(`Safety map image has unsupported content type: ${contentType || "missing"}`);
  }
  const declaredLength = Number(imageResponse.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > TWITTER_IMAGE_MAX_BYTES) {
    await drainResponseBody(imageResponse);
    throw new Error(`Safety map image exceeds ${TWITTER_IMAGE_MAX_BYTES} bytes`);
  }
  const imageBytes = await imageResponse.arrayBuffer();
  if (imageBytes.byteLength === 0 || imageBytes.byteLength > TWITTER_IMAGE_MAX_BYTES) {
    throw new Error(`Safety map image size is invalid: ${imageBytes.byteLength}`);
  }

  const authHeader = await buildOAuthHeader("POST", TWITTER_MEDIA_UPLOAD_URL, creds);
  const body = new FormData();
  body.append("media", new Blob([imageBytes], { type: "image/png" }), "pharos-safety-score-map.png");
  body.append("media_category", "tweet_image");
  const uploadSignal = AbortSignal.timeout(15_000);
  const response = await fetch(TWITTER_MEDIA_UPLOAD_URL, {
    method: "POST",
    headers: { Authorization: authHeader },
    body,
    signal: uploadSignal,
  });
  const raw = await readResponseTextBoundedWithSignal(response, 16_384, uploadSignal);
  if (!response.ok) throw new Error(`Twitter media API ${response.status}: ${raw.slice(0, 300)}`);
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error("Twitter media API returned invalid JSON");
  }
  const mediaId = (decoded as { media_id_string?: unknown })?.media_id_string;
  if (typeof mediaId !== "string" || !/^\d+$/.test(mediaId)) {
    throw new Error("Twitter media API response omitted media_id_string");
  }
  return mediaId;
}

/**
 * Build tweet text from digest and post it.
 * The caller is responsible for catching errors.
 *
 * A mapped edition is all-or-nothing: when `imageUrl` is set, a media upload
 * failure aborts the tweet (after one bounded retry) instead of degrading to a
 * text-only post — the digest delivery contract requires the Safety Score map.
 */
export async function postDigestTweet(
  digestTitle: string,
  digestText: string,
  creds: TwitterCreds,
  editionNumber?: number | null,
  imageUrl?: string | null,
  mapHook?: string | null,
  digestMetadata?: unknown,
): Promise<{ tweetId: string; mediaAttached: boolean }> {
  let mediaId: string | undefined;
  if (imageUrl) {
    try {
      mediaId = await uploadTweetImage(imageUrl, creds);
    } catch (error) {
      logWorkerEventArgs("lib", "warn", `[twitter] Safety map upload failed, retrying once: ${toErrorMessage(error)}`);
      try {
        mediaId = await uploadTweetImage(imageUrl, creds);
      } catch (retryError) {
        // No tweet was attempted, so this abort is a known non-post: tag it
        // definitive so the delivery ledger keeps the bounded retry path open
        // instead of freezing the day in execution_unknown.
        throw new TwitterPostError(
          `Safety map upload failed; mapped digest tweet aborted: ${toErrorMessage(retryError)}`,
          "definitive_failure",
          null,
        );
      }
    }
  }
  const tweetText = buildTweetText(
    digestTitle,
    digestText,
    editionNumber,
    mediaId ? mapHook : null,
    digestMetadata,
  );
  const tweetId = await postTweet(tweetText, creds, mediaId);
  logWorkerEventArgs("lib", "info", `[twitter] Posted digest tweet (${tweetText.length} chars${mediaId ? ", safety map attached" : ""})`);
  return { tweetId, mediaAttached: Boolean(mediaId) };
}
