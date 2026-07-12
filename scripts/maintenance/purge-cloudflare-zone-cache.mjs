#!/usr/bin/env node

import { assertCliUsage, parseStrictCliArgs, runCliEntrypoint, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import { isDirectRun, sleep } from "../lib/smoke-runtime.mjs";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ZONE_NAME = "pharos.watch";
const USAGE = `Usage: node scripts/maintenance/purge-cloudflare-zone-cache.mjs [options]

Options:
  --zone <name>  Active Cloudflare zone to purge (default: pharos.watch)
  --dry-run      Validate inputs and print the target without calling Cloudflare
  -h, --help     Show this help

Required environment for a live purge:
  CLOUDFLARE_API_TOKEN`;

class CloudflareApiError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = "CloudflareApiError";
    this.retryable = retryable;
  }
}

export function parseZoneCachePurgeArgs(argv) {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      zone: { type: "string" },
      "dry-run": { type: "boolean" },
    },
  });
  return {
    zone: typeof values.zone === "string" ? values.zone.trim().toLowerCase() : undefined,
    dryRun: values["dry-run"] === true,
    help: values.help === true,
  };
}

function isValidZoneName(value) {
  if (value.length > 253) return false;
  const labels = value.split(".");
  if (labels.length < 2) return false;
  return labels.every((label) => {
    if (label.length < 1 || label.length > 63) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
    return [...label].every(
      (character) =>
        (character >= "a" && character <= "z") || (character >= "0" && character <= "9") || character === "-",
    );
  });
}

async function parseCloudflareResponse(response, operation) {
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  const detail = Array.isArray(payload?.errors)
    ? payload.errors
        .map((error) => error?.message)
        .filter(Boolean)
        .join("; ")
    : "";
  if (!response.ok || payload?.success !== true) {
    throw new CloudflareApiError(
      `${operation} failed (HTTP ${response.status}): ${detail || text.slice(0, 200) || "(no body)"}`,
      { retryable: response.status === 429 || response.status >= 500 },
    );
  }

  if (payload === null || typeof payload !== "object") {
    throw new CloudflareApiError(`${operation} returned an unparseable success response`);
  }
  return payload;
}

async function withTransientRetry(operation, { maxAttempts, retryDelayMs, onAttemptError }) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const retryable = !(error instanceof CloudflareApiError) || error.retryable;
      onAttemptError?.(attempt, error, retryable);
      if (!retryable || attempt === maxAttempts) break;
      await sleep(retryDelayMs * attempt);
    }
  }
  throw lastError;
}

/**
 * Purge one exact active Cloudflare zone after a fail-closed lookup by name.
 * The purge-everything operation is idempotent, so transient retries are safe.
 *
 * @param {{
 *   apiToken: string,
 *   zoneName: string,
 *   fetchImpl?: typeof fetch,
 *   maxAttempts?: number,
 *   retryDelayMs?: number,
 *   timeoutMs?: number,
 *   onAttemptError?: (attempt: number, error: unknown, retryable: boolean) => void,
 * }} options
 */
export async function purgeCloudflareZoneCache({
  apiToken,
  zoneName,
  fetchImpl = fetch,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onAttemptError,
}) {
  if (!apiToken) throw new Error("purgeCloudflareZoneCache: apiToken is required");
  if (!zoneName || !isValidZoneName(zoneName)) {
    throw new Error("purgeCloudflareZoneCache: zoneName must be a valid DNS zone name");
  }

  const headers = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };
  const lookupUrl = new URL("https://api.cloudflare.com/client/v4/zones");
  lookupUrl.searchParams.set("name", zoneName);
  lookupUrl.searchParams.set("status", "active");
  lookupUrl.searchParams.set("per_page", "5");

  const lookupPayload = await withTransientRetry(
    async () => {
      const response = await fetchImpl(lookupUrl, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return parseCloudflareResponse(response, "Cloudflare zone lookup");
    },
    { maxAttempts, retryDelayMs, onAttemptError },
  );

  const zones = Array.isArray(lookupPayload.result) ? lookupPayload.result : [];
  if (zones.length !== 1 || zones[0]?.name !== zoneName || typeof zones[0]?.id !== "string") {
    throw new Error(
      `Cloudflare zone lookup returned ${zones.length} exact active matches for ${zoneName}; refusing to purge`,
    );
  }

  await withTransientRetry(
    async () => {
      const response = await fetchImpl(
        `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zones[0].id)}/purge_cache`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ purge_everything: true }),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      return parseCloudflareResponse(response, "Cloudflare zone cache purge");
    },
    { maxAttempts, retryDelayMs, onAttemptError },
  );
}

export async function runZoneCachePurgeCli(argv = process.argv.slice(2), env = process.env) {
  const options = parseZoneCachePurgeArgs(argv);
  if (writeCliHelpIfRequested(options, USAGE)) return;

  const zoneName = options.zone ?? DEFAULT_ZONE_NAME;
  assertCliUsage(isValidZoneName(zoneName), "--zone must be a valid DNS zone name");
  if (options.dryRun) {
    console.log(`[purge-zone-cache] dry run: would purge all cached files for ${zoneName}`);
    return;
  }

  const apiToken = (env.CLOUDFLARE_API_TOKEN ?? "").trim();
  assertCliUsage(Boolean(apiToken), "CLOUDFLARE_API_TOKEN is required");
  await purgeCloudflareZoneCache({
    apiToken,
    zoneName,
    onAttemptError: (attempt, error, retryable) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[purge-zone-cache] attempt ${attempt} failed (${retryable ? "retryable" : "terminal"}): ${message}`,
      );
    },
  });
  console.log(`[purge-zone-cache] purged all cached files for ${zoneName}`);
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void runCliEntrypoint(() => runZoneCachePurgeCli(), {
    label: "purge-zone-cache",
    usage: USAGE,
  });
}
