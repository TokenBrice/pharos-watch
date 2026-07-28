import type { D1Database } from "@cloudflare/workers-types";
import {
  TELEGRAM_ADOPTION_CTA_PLACEMENTS,
  TELEGRAM_ADOPTION_LOW_COUNT_THRESHOLD,
} from "@shared/lib/telegram-adoption-analytics";
import { readBoundedRequestBody } from "./lib/bounded-request-body";
import { hashClientIp } from "./lib/client-ip-hash";
import { rejectIfNotSiteDataUiOrigin } from "./lib/site-data-origin";
import { z } from "zod";

const MAX_BODY_BYTES = 512;
const GLOBAL_REQUESTS_PER_MINUTE = 3_000;
const CLIENT_REQUESTS_PER_MINUTE = 10;
const TelegramAdoptionClickSchema = z
  .object({
    campaign: z.literal("landing"),
    placement: z.enum(TELEGRAM_ADOPTION_CTA_PLACEMENTS),
  })
  .strict();

interface TelegramAdoptionPagesEnv {
  DB?: D1Database;
  SITE_ORIGIN?: string;
  OPS_UI_ORIGIN?: string;
  TELEGRAM_ADOPTION_IP_HASH_SECRET?: string;
}

interface TelegramAdoptionPagesContext {
  request: Request;
  env: TelegramAdoptionPagesEnv;
}

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

async function readBoundedJson(request: Request): Promise<unknown | null> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return null;
  const result = await readBoundedRequestBody(request, MAX_BODY_BYTES);
  if (result.status !== "ok") return null;
  try {
    return JSON.parse(new TextDecoder().decode(result.bytes));
  } catch {
    return null;
  }
}

async function getClientIpHash(request: Request, env: TelegramAdoptionPagesEnv): Promise<string | null> {
  const ip = request.headers.get("CF-Connecting-IP");
  const secret = env.TELEGRAM_ADOPTION_IP_HASH_SECRET?.trim();
  if (!ip || !secret) return null;
  return hashClientIp(ip, secret);
}

async function admitClientMinute(db: D1Database, ipHash: string, nowSec: number): Promise<boolean> {
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
    .bind(bucketStart, ipHash, nowSec, CLIENT_REQUESTS_PER_MINUTE)
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

export const onRequest = async ({ request, env }: TelegramAdoptionPagesContext): Promise<Response> => {
  if (request.method !== "POST") return response(405, null, { Allow: "POST" });
  const rejected = rejectIfNotSiteDataUiOrigin(request, env, () => response(404));
  if (rejected) return rejected;
  if (!env.DB) return response(503);

  const parsed = TelegramAdoptionClickSchema.safeParse(await readBoundedJson(request));
  if (!parsed.success) return response(400);

  const ipHash = await getClientIpHash(request, env);
  if (!ipHash) return response(503);

  const nowSec = Math.floor(Date.now() / 1_000);
  if (!(await admitClientMinute(env.DB, ipHash, nowSec))) {
    return response(429, null, { "Retry-After": "60" });
  }

  if (!(await admitGlobalMinute(env.DB, nowSec))) {
    return response(429, null, { "Retry-After": "60" });
  }

  const day = new Date(nowSec * 1_000).toISOString().slice(0, 10);
  await env.DB.prepare(
    `INSERT INTO telegram_adoption_daily (
         day, campaign, placement, stage, feature, latency_bucket, outcome,
         count, first_seen_at, last_seen_at
       ) VALUES (?, ?, ?, 'cta_click', '', '', 'success', 1, ?, ?)
       ON CONFLICT(day, campaign, placement, stage, feature, latency_bucket, outcome)
       DO UPDATE SET count = telegram_adoption_daily.count + 1, last_seen_at = excluded.last_seen_at`,
  )
    .bind(day, parsed.data.campaign, parsed.data.placement, nowSec, nowSec)
    .run();

  return response(204, null, {
    "X-Analytics-Quality": `best-effort; suppression=${TELEGRAM_ADOPTION_LOW_COUNT_THRESHOLD}`,
  });
};
