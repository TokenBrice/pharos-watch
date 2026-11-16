import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { API_ORIGIN, SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { hashClientIp } from "@shared/lib/client-ip-hash";
import { SOCIAL_SCORECARD_DAILY_QUOTA } from "@shared/lib/pages-storage";
import { SOCIAL_SCORECARD_OBJECT_PREFIX, type SocialPreviewBucket } from "@shared/lib/social-preview-storage";
import {
  hasSiteSessionSigningKey,
  readSiteSessionCookie,
  SITE_SESSION_HINT_HEADER,
  verifySiteSessionToken,
} from "@shared/lib/site-session-token";
import type { D1Database } from "@shared/types/cloudflare-runtime";
import {
  SOCIAL_SCORECARD_METADATA_HEADER,
  SOCIAL_SCORECARD_MAX_IMAGE_BYTES,
  SOCIAL_SCORECARD_RENDERER_REVISION,
  decodeSocialScorecardMetadata,
  sealSocialScorecard,
  openSocialScorecard,
  socialScorecardDate,
  socialScorecardLivePath,
  socialScorecardPaths,
  socialScorecardSummary,
  socialScorecardTitle,
} from "@shared/lib/social-scorecard";
import { SocialScorecardCreateSchema, type SealedSocialScorecard, type SocialScorecardMetadata } from "@shared/types/social-scorecard";
import { readBoundedRequestBody } from "./bounded-request-body";
import { jsonError } from "./proxy-utils";
import { rejectIfNotSiteDataUiOrigin } from "./site-data-origin";
import { fetchUpstreamProxy, type ProxyServiceBinding } from "./upstream-proxy";

export interface SocialScorecardEnv {
  SOCIAL_PREVIEWS?: SocialPreviewBucket;
  DB?: D1Database;
  SELECTOR_SNAPSHOT_IP_HASH_SECRET?: string;
  SITE_API?: ProxyServiceBinding;
  SITE_ORIGIN?: string;
  OPS_UI_ORIGIN?: string;
  SITE_SESSION_ENFORCEMENT?: string;
  SITE_SESSION_SIGNING_KEY?: string;
  SITE_SESSION_SIGNING_KEY_PREVIOUS?: string;
}

async function captureSocialScorecard(request: Request, stablecoinId: string, serviceBinding?: ProxyServiceBinding): Promise<SealedSocialScorecard> {
  // OG is public-exempt, not a site-data endpoint. Always address the canonical
  // public lane even over a binding; no request header or input chooses a URL.
  const upstream = await fetchUpstreamProxy(request, {
    upstreamUrl: new URL(API_PATHS.ogScorecard(stablecoinId), API_ORIGIN).toString(),
    method: "GET", headers: new Headers({ Accept: "image/png" }), serviceBinding,
    timeoutMs: 15_000, timeoutReason: new DOMException("Scorecard capture timed out", "TimeoutError"),
    logPrefix: "social-scorecard", timeoutMessage: "Scorecard capture timed out", fetchFailedMessage: "Scorecard capture unavailable",
  });
  if (!upstream.ok || !upstream.response.ok || upstream.response.status !== 200
    || upstream.response.headers.get("Content-Type")?.split(";")[0].trim() !== "image/png") {
    throw new Error("Scorecard source unavailable");
  }
  const metadata = decodeSocialScorecardMetadata(upstream.response.headers.get(SOCIAL_SCORECARD_METADATA_HEADER));
  const image = new Uint8Array(await upstream.response.arrayBuffer());
  if (image.byteLength > SOCIAL_SCORECARD_MAX_IMAGE_BYTES) throw new Error("Scorecard image too large");
  const now = Math.floor(Date.now() / 1000);
  if (metadata.rendererRevision !== SOCIAL_SCORECARD_RENDERER_REVISION || metadata.subject.id !== stablecoinId
    || metadata.asOfSec <= 0 || metadata.asOfSec > now || metadata.publishedAtSec > now
    || now - metadata.asOfSec >= metadata.freshnessBudgetSec || now - metadata.publishedAtSec >= metadata.freshnessBudgetSec) {
    throw new Error("Scorecard source identity or freshness invalid");
  }
  return sealSocialScorecard(metadata, image);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

export function scorecardHtml(id: string, metadata: SocialScorecardMetadata): string {
  const paths = socialScorecardPaths(id);
  const url = new URL(paths.url, SITE_ORIGIN).toString();
  const imageUrl = new URL(paths.imageUrl, SITE_ORIGIN).toString();
  const liveUrl = new URL(socialScorecardLivePath(metadata), SITE_ORIGIN).toString();
  const title = `${socialScorecardTitle(metadata)} — ${socialScorecardDate(metadata)}`;
  const summary = socialScorecardSummary(metadata);
  const method = metadata.publication.methodologyVersion;
  const methodology = method.startsWith("v") ? method : `v${method}`;
  const description = `${summary} As of ${socialScorecardDate(metadata)}. Methodology ${methodology}. Retained edition, not a live rating.`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} | Pharos</title><meta name="description" content="${escapeHtml(description)}">
<meta name="robots" content="noindex, follow"><link rel="canonical" href="${url}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Pharos"><meta property="og:url" content="${url}">
<meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${imageUrl}"><meta property="og:image:secure_url" content="${imageUrl}"><meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="${escapeHtml(description)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escapeHtml(title)}"><meta name="twitter:description" content="${escapeHtml(description)}"><meta name="twitter:image" content="${imageUrl}"><meta name="twitter:image:alt" content="${escapeHtml(description)}">
<style>
:root{color-scheme:light dark;--page:#f3f6fa;--panel:#fff;--ink:#142132;--muted:#526376;--line:#cfdae5;--accent:#194f94}
@media(prefers-color-scheme:dark){:root{--page:#0b1220;--panel:#111d2e;--ink:#eef5ff;--muted:#abbcd0;--line:#2b3e55;--accent:#b4d9ff}}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:1080px;margin:auto;padding:clamp(20px,4vw,48px)}a{color:var(--accent);text-underline-offset:3px}
header{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:32px}.brand{font-size:20px;font-weight:800;letter-spacing:.08em;text-decoration:none;color:var(--ink)}
.edition{border:1px solid var(--line);border-radius:999px;padding:7px 12px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
h1{font-size:clamp(28px,5vw,48px);line-height:1.12;letter-spacing:-.035em;margin:0 0 12px}.date{color:var(--muted);margin:0 0 24px}
figure{margin:0;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--panel)}figure img{display:block;width:100%;height:auto}
.actions{display:flex;align-items:center;flex-wrap:wrap;gap:16px;margin:24px 0}.current{display:inline-flex;min-height:48px;align-items:center;padding:12px 20px;background:var(--ink);color:var(--page);border-radius:8px;font-weight:700;text-decoration:none}
.note{max-width:75ch;color:var(--muted);font-size:14px}details{margin-top:28px;padding-top:20px;border-top:1px solid var(--line);font-size:14px}summary{cursor:pointer;font-weight:650}dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:10px 20px;margin:20px 0}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}code{font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}
@media(max-width:520px){header{align-items:flex-start}.edition{max-width:160px;text-align:center}dl{display:block}dt{margin-top:16px}.current{width:100%;justify-content:center}}
@media(prefers-reduced-motion:no-preference){a{transition:opacity .15s}a:hover{opacity:.8}}a:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:4px}
</style></head><body><main>
<header><a class="brand" href="/">PHAROS</a><span class="edition">Dated edition · Not live</span></header>
<h1>${escapeHtml(socialScorecardTitle(metadata))}</h1>
<p class="date">Observed ${socialScorecardDate(metadata)} · Methodology ${escapeHtml(methodology)}</p>
<figure><img src="${paths.imageUrl}" width="1200" height="630" alt="${escapeHtml(description)}"></figure>
<nav class="actions" aria-label="Scorecard actions"><a class="current" href="${liveUrl}">Open current analysis →</a><a href="${paths.imageUrl}" download>Download retained PNG</a></nav>
<p class="note">This edition preserves one accepted publication, not a live rating. Published letter grades may include boundary hysteresis; they are not recalculated from the numeric score.</p>
<details><summary>Publication provenance</summary><dl>
<dt>Observed</dt><dd>${socialScorecardDate(metadata)}</dd>
<dt>Published</dt><dd>${new Date(metadata.publishedAtSec * 1000).toISOString()}</dd>
<dt>Source freshness budget</dt><dd>${metadata.freshnessBudgetSec} seconds at capture</dd>
<dt>Generation</dt><dd><code>${escapeHtml(metadata.publication.publicationGenerationId)}</code></dd>
<dt>Evaluation build</dt><dd><code>${metadata.publication.evaluationBuildDigest}</code></dd>
<dt>Policy</dt><dd><code>${escapeHtml(metadata.publication.policyId)}</code></dd>
<dt>Renderer</dt><dd><code>${escapeHtml(metadata.rendererRevision)}</code></dd>
<dt>Image SHA-256</dt><dd><code>${metadata.imageSha256}</code></dd>
</dl></details></main></body></html>`;
}

async function reserveCreationAttempt(db: D1Database, ipHash: string): Promise<Response | null> {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const quotaDate = new Date(nowMs).toISOString().slice(0, 10);
  const pruneBefore = new Date(nowMs - 2 * 86_400_000).toISOString().slice(0, 10);
  const retryAfter = String(Math.ceil((Date.parse(`${quotaDate}T00:00:00Z`) + 86_400_000 - nowMs) / 1000));
  const quota = SOCIAL_SCORECARD_DAILY_QUOTA;
  try {
    // D1 batches are transactional. Both guarded counters reserve before any
    // render; concurrent isolates cannot pass either durable daily ceiling.
    const results = await db.batch([
      db.prepare(quota.pruneSql).bind(pruneBefore),
      db.prepare(quota.consumeSql).bind(quotaDate, quota.globalKey, nowSec, nowSec, quota.maxGlobal),
      db.prepare(quota.consumeIpSql).bind(quotaDate, ipHash, nowSec, nowSec, quota.maxPerIp),
    ]);
    if (results.length !== 3 || results.some((result) => !result.success)
      || ![0, 1].includes(results[1].meta.changes) || ![0, 1].includes(results[2].meta.changes)) {
      throw new Error("Unknown scorecard quota reservation");
    }
    const globalReserved = results[1].meta.changes === 1;
    const ipReserved = results[2].meta.changes === 1;
    if (ipReserved && globalReserved) return null;
    // If the IP bucket refuses, undo only this attempt's global reservation.
    // Keep the original UTC date even if the request crossed midnight.
    if (globalReserved) {
      const refund = await db.prepare(quota.refundSql).bind(quotaDate, quota.globalKey).run();
      if (!refund.success || refund.meta.changes !== 1) throw new Error("Scorecard quota release failed");
    }
    return jsonError(429, "Daily scorecard creation quota exceeded", { "Retry-After": retryAfter });
  } catch {
    return jsonError(503, "Scorecard quota store temporarily unavailable");
  }
}

export async function createSocialScorecard(request: Request, env: SocialScorecardEnv): Promise<Response> {
  const denied = rejectIfNotSiteDataUiOrigin(request, env, () => jsonError(404, "Not found"));
  if (denied) return denied;
  if (request.method !== "POST") return jsonError(405, "Method not allowed", { Allow: "POST" });
  if (env.SITE_SESSION_ENFORCEMENT === "enforce") {
    if (!hasSiteSessionSigningKey(env.SITE_SESSION_SIGNING_KEY)) return jsonError(503, "Site session is not configured");
    const session = await verifySiteSessionToken({
      token: readSiteSessionCookie(request.headers.get("Cookie")),
      keys: [env.SITE_SESSION_SIGNING_KEY, env.SITE_SESSION_SIGNING_KEY_PREVIOUS],
      nowSec: Math.floor(Date.now() / 1000),
    });
    if (!session.ok) return jsonError(401, "Site session required", { [SITE_SESSION_HINT_HEADER]: "required" });
  }
  if (!env.SOCIAL_PREVIEWS) return jsonError(503, "Scorecard store is not configured");
  if (!env.DB) return jsonError(503, "Scorecard quota store is not configured");
  const secret = env.SELECTOR_SNAPSHOT_IP_HASH_SECRET?.trim();
  const ip = request.headers.get("CF-Connecting-IP");
  if (!secret || !ip) return jsonError(503, "Scorecard write limiter is not configured");
  if (request.headers.get("Content-Type")?.split(";")[0].trim() !== "application/json") return jsonError(415, "Expected application/json");
  const body = await readBoundedRequestBody(request, 256, request.signal);
  if (body.status !== "ok") return jsonError(body.status === "too-large" ? 413 : 400, "Invalid scorecard request body");
  let stablecoinId: string;
  try {
    const input = SocialScorecardCreateSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.bytes)));
    stablecoinId = input.stablecoinId;
  } catch {
    return jsonError(400, "Expected only a canonical stablecoinId");
  }
  const ipHash = await hashClientIp(`social-scorecard:${ip}`, secret);
  const quotaDenied = await reserveCreationAttempt(env.DB, ipHash);
  if (quotaDenied) return quotaDenied;
  // A successful dual reservation remains charged on capture/storage failure.
  let snapshot: SealedSocialScorecard;
  try {
    snapshot = await captureSocialScorecard(request, stablecoinId, env.SITE_API);
  } catch {
    return jsonError(503, "Published scorecard temporarily unavailable", { "Retry-After": "60" });
  }
  const key = `${SOCIAL_SCORECARD_OBJECT_PREFIX}${snapshot.id}`;
  try {
    const existing = await env.SOCIAL_PREVIEWS.get(key);
    if (existing !== null) {
      // Even a corrupt existing object must never be silently replaced.
      openSocialScorecard(snapshot.id, await existing.text());
    } else {
      await env.SOCIAL_PREVIEWS.put(key, JSON.stringify(snapshot.record), {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "application/json" },
      });
      // Conditional-create losers read the winner. R2's strongly consistent
      // readback also proves the returned public links are immediately usable.
      const retained = await env.SOCIAL_PREVIEWS.get(key);
      if (!retained) throw new Error("Scorecard object was not retained");
      openSocialScorecard(snapshot.id, await retained.text());
    }
  } catch {
    return jsonError(503, "Scorecard store temporarily unavailable");
  }
  const paths = socialScorecardPaths(snapshot.id);
  return new Response(JSON.stringify({ url: new URL(paths.url, SITE_ORIGIN).toString(), imageUrl: new URL(paths.imageUrl, SITE_ORIGIN).toString() }), {
    status: 201,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" },
  });
}
