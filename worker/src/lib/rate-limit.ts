import { errorResponse } from "./api-utils";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const ipCounts = new Map<string, RateLimitEntry>();
const PRUNE_EVERY_REQUESTS = 1000;
let requestCount = 0;

function pruneExpired(now: number): void {
  for (const [ip, entry] of ipCounts.entries()) {
    if (now > entry.resetAt) {
      ipCounts.delete(ip);
    }
  }
}

export function checkRateLimit(
  ip: string,
  limit = 60,
  windowMs = 60_000,
): Response | null {
  const now = Date.now();
  requestCount++;
  if (requestCount % PRUNE_EVERY_REQUESTS === 0) {
    pruneExpired(now);
  }

  const entry = ipCounts.get(ip);
  if (!entry || now > entry.resetAt) {
    ipCounts.set(ip, { count: 1, resetAt: now + windowMs });
    return null;
  }

  entry.count++;
  if (entry.count > limit) {
    const resp = errorResponse(429, "Rate limit exceeded");
    resp.headers.set("Retry-After", String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
    return resp;
  }

  return null;
}
