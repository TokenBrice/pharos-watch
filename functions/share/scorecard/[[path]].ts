import { scorecardHtml, type SocialScorecardEnv } from "../../lib/social-scorecard";
import { sha256Hex } from "@shared/lib/sha256";
import { SOCIAL_SCORECARD_OBJECT_PREFIX } from "@shared/lib/social-preview-storage";
import {
  isSocialScorecardId,
  openSocialScorecard,
} from "@shared/lib/social-scorecard";
import { jsonError } from "../../lib/proxy-utils";

interface ScorecardContext {
  request: Request;
  env: SocialScorecardEnv;
  params: { path?: string | string[] };
}

const RESPONSE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, follow",
  "Referrer-Policy": "no-referrer",
};

function matchesIfNoneMatch(header: string | null, etag: string): boolean {
  if (header === null) return false;
  const value = header.trim();
  if (value === "*") return true;
  // GET/HEAD use weak comparison; a comma inside an opaque tag is not a separator.
  const tags = /[ \t]*(?:W\/)?"([\x21\x23-\x7e\x80-\xff]*)"[ \t]*(?:,|$)/gy;
  let offset = 0;
  let matched = false;
  while (offset < value.length) {
    // HTTP list recipients ignore empty members.
    if (value[offset] === "," || value[offset] === " " || value[offset] === "\t") {
      offset++;
      continue;
    }
    tags.lastIndex = offset;
    const tag = tags.exec(value);
    if (!tag) return false;
    matched ||= `"${tag[1]}"` === etag;
    offset = tags.lastIndex;
  }
  return matched;
}

async function readScorecard(context: ScorecardContext, id: string, imageOnly: boolean): Promise<Response> {
  const bucket = context.env.SOCIAL_PREVIEWS;
  if (!bucket) return jsonError(503, "Scorecard store is not configured");
  let raw: string;
  try {
    const retained = await bucket.get(`${SOCIAL_SCORECARD_OBJECT_PREFIX}${id}`);
    if (!retained) return jsonError(404, "Dated scorecard not found");
    raw = await retained.text();
  } catch {
    return jsonError(503, "Scorecard store temporarily unavailable");
  }
  try {
    const { metadata, image } = openSocialScorecard(id, raw);
    const html = imageOnly ? null : scorecardHtml(id, metadata);
    const etag = `"${imageOnly ? metadata.imageSha256 : sha256Hex(html!)}"`;
    const headers = {
      ...RESPONSE_HEADERS,
      "Content-Type": imageOnly ? "image/png" : "text/html; charset=utf-8",
      "Cache-Control": imageOnly ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate",
      ETag: etag,
    };
    if (matchesIfNoneMatch(context.request.headers.get("If-None-Match"), etag)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(context.request.method.toUpperCase() === "HEAD" ? null : imageOnly ? image as Uint8Array<ArrayBuffer> : html, { headers });
  } catch {
    return jsonError(502, "Dated scorecard integrity check failed");
  }
}

export const onRequest = async (context: ScorecardContext): Promise<Response> => {
  const method = context.request.method.toUpperCase();
  const raw = context.params.path;
  const segments = raw === undefined ? [] : (Array.isArray(raw) ? raw : [raw]).filter((segment) => segment !== "");
  if (method !== "GET" && method !== "HEAD") return jsonError(405, "Method not allowed", { Allow: "GET, HEAD" });
  if (segments.length !== 1) return jsonError(404, "Not found");
  const candidate = segments[0];
  const imageOnly = candidate.endsWith(".png");
  const id = imageOnly ? candidate.slice(0, -4) : candidate;
  if (!isSocialScorecardId(id)) return jsonError(404, "Not found");
  return readScorecard(context, id, imageOnly);
};
