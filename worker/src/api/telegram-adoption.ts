import {
  TELEGRAM_ADOPTION_CTA_PLACEMENTS,
  TELEGRAM_ADOPTION_LOW_COUNT_THRESHOLD,
} from "@shared/lib/telegram-adoption-analytics";
import { bufferReadableStream } from "@shared/lib/bounded-stream";
import {
  hostnameOfSiteDataCallerHeader,
  isSiteDataAllowedUiHostname,
} from "@shared/lib/site-data-lane";
import { writeTelegramAdoptionEvent } from "../lib/telegram-adoption-analytics";
import type { FullRouteContext } from "../routes/shared";
import { z } from "zod";

const MAX_BODY_BYTES = 512;
const GLOBAL_REQUESTS_PER_MINUTE = 3_000;
const CLIENT_REQUESTS_PER_MINUTE = 10;
const CLIENT_HASH_HEADER = "X-Pharos-Telegram-Adoption-Client-Hash";
const TelegramAdoptionClickSchema = z
  .object({
    campaign: z.literal("landing"),
    placement: z.enum(TELEGRAM_ADOPTION_CTA_PLACEMENTS),
  })
  .strict();

function response(status: number, body: string | null = null, headers: HeadersInit = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

function isAllowedUiOrigin(request: Request): boolean {
  const originHost = hostnameOfSiteDataCallerHeader(request.headers.get("Origin"));
  if (originHost !== null) return isSiteDataAllowedUiHostname(originHost);

  const refererHost = hostnameOfSiteDataCallerHeader(request.headers.get("Referer"));
  return refererHost !== null && isSiteDataAllowedUiHostname(refererHost);
}

async function readBoundedJson(request: Request): Promise<unknown | null> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return null;

  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) return null;
  if (!request.body) return null;

  try {
    const { bytes } = await bufferReadableStream(request.body, { maxBytes: MAX_BODY_BYTES });
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

async function admitClientMinute(db: D1Database, clientHash: string, nowSec: number): Promise<boolean> {
  const bucketStart = nowSec - (nowSec % 60);
  const row = await db
    .prepare(
      `INSERT INTO telegram_adoption_client_quota (bucket_start, ip_hash, request_count, updated_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(bucket_start, ip_hash) DO UPDATE SET
         request_count = telegram_adoption_client_quota.request_count + 1,
         updated_at = excluded.updated_at
       WHERE telegram_adoption_client_quota.request_count < ?
       RETURNING request_count`,
    )
    .bind(bucketStart, clientHash, nowSec, CLIENT_REQUESTS_PER_MINUTE)
    .first<{ request_count: number }>();
  return row != null;
}

async function admitGlobalMinute(db: D1Database, nowSec: number): Promise<boolean> {
  const bucketStart = nowSec - (nowSec % 60);
  const row = await db
    .prepare(
      `INSERT INTO telegram_adoption_ingress_quota (bucket_start, request_count, updated_at)
       VALUES (?, 1, ?)
       ON CONFLICT(bucket_start) DO UPDATE SET
         request_count = telegram_adoption_ingress_quota.request_count + 1,
         updated_at = excluded.updated_at
       WHERE telegram_adoption_ingress_quota.request_count < ?
       RETURNING request_count`,
    )
    .bind(bucketStart, nowSec, GLOBAL_REQUESTS_PER_MINUTE)
    .first<{ request_count: number }>();
  return row != null;
}

export async function handleTelegramAdoption({ db, request }: FullRouteContext): Promise<Response> {
  if (request.method !== "POST") return response(405, null, { Allow: "POST" });
  if (!isAllowedUiOrigin(request)) return response(404);

  const parsed = TelegramAdoptionClickSchema.safeParse(await readBoundedJson(request));
  if (!parsed.success) return response(400);

  const clientHash = request.headers.get(CLIENT_HASH_HEADER)?.trim();
  if (!clientHash || !/^[0-9a-f]{32}$/.test(clientHash)) return response(503);

  const nowSec = Math.floor(Date.now() / 1_000);
  if (!(await admitClientMinute(db, clientHash, nowSec))) {
    return response(429, null, { "Retry-After": "60" });
  }

  if (!(await admitGlobalMinute(db, nowSec))) {
    return response(429, null, { "Retry-After": "60" });
  }

  try {
    await writeTelegramAdoptionEvent(db, {
      campaign: parsed.data.campaign,
      placement: parsed.data.placement,
      stage: "cta_click",
      nowSec,
    });
  } catch {
    return response(500);
  }

  return response(204, null, {
    "X-Analytics-Quality": `best-effort; suppression=${TELEGRAM_ADOPTION_LOW_COUNT_THRESHOLD}`,
  });
}
