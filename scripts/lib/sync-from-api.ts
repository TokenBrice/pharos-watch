/**
 * Shared helpers for `sync-*.ts` maintenance scripts that pull a snapshot
 * from a Pharos API endpoint and write a JSON mirror under `data/`.
 *
 * Extracts the URL-resolution and file-write boilerplate common to
 * sync-digests.ts and sync-depeg-events.ts.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SITE_DATA_PROXY_SECRET_HEADER } from "@shared/lib/site-data-lane";

import { sleep } from "./smoke-runtime.mjs";

interface ResolveApiUrlOptions {
  /** CLI flag label used in error messages, e.g. `--api-url`. */
  argName: string;
  /** Already-parsed CLI override. */
  explicitUrl?: string | null;
  /**
   * Ordered list of environment variables to consult after the CLI flag.
   * The first non-empty value wins.
   */
  envNames: readonly string[];
  /**
   * Path suffix to append to the resolved base, e.g. `/api/digest-archive`.
   * If the resolved URL already ends with this suffix, it is returned as-is.
   */
  apiPath: string;
  /** Script name used in the error message when nothing resolves. */
  scriptName: string;
}

/**
 * Resolve an API URL from `--api-url` or one of `envNames`, then append
 * `apiPath` unless it's already present. Throws when nothing is configured.
 */
export function resolveApiUrl(options: ResolveApiUrlOptions): string {
  const { argName, explicitUrl, envNames, apiPath, scriptName } = options;
  const explicit =
    explicitUrl?.trim() ||
    envNames.map((name) => process.env[name]).find((value) => value != null && value !== "") ||
    null;
  if (!explicit) {
    throw new Error(
      `Provide ${argName} or set ${envNames.join(" / ")} before running ${scriptName}.`,
    );
  }
  if (explicit.endsWith(apiPath)) return explicit;
  return `${explicit.replace(/\/+$/, "")}${apiPath}`;
}

interface FetchWithRetryOptions {
  /** Label used in retry logs, without surrounding brackets. */
  logLabel: string;
  attempts?: number;
  backoffMs?: readonly number[];
  /** Additional response statuses that are known to be transient for this caller. */
  retryStatuses?: readonly number[];
}

/**
 * Build-time retry helper for the `sync-*.ts` maintenance scripts.
 *
 * Deliberately simpler than the worker's `worker/src/lib/fetch-retry.ts`: these
 * scripts run in Node (local/CI), not inside a Cloudflare cron, so they do not
 * need AbortSignal composition, the Worker's trigger-budget response-body draining, or
 * Retry-After/529 exponential backoff. A fixed backoff array with a `status < 500`
 * short-circuit is enough for transient upstream 5xx during a snapshot pull, so
 * the two retry policies are intentionally not unified.
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retryOptions: FetchWithRetryOptions,
): Promise<Response> {
  const attempts = retryOptions.attempts ?? 3;
  const backoff = retryOptions.backoffMs ?? [1000, 2000];
  const retryStatuses = new Set(retryOptions.retryStatuses ?? []);
  for (let i = 0; i < attempts; i++) {
    let res: Response;
    try {
      res = await fetch(url, options);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (i < attempts - 1) {
        const delay = backoff[i] ?? backoff[backoff.length - 1];
        console.log(
          `[${retryOptions.logLabel}] Attempt ${i + 1}/${attempts} failed (${reason}); retrying in ${delay}ms...`,
        );
        await sleep(delay);
        continue;
      }
      throw err;
    }
    if (res.ok || (res.status < 500 && !retryStatuses.has(res.status))) return res;
    if (i < attempts - 1) {
      const delay = backoff[i] ?? backoff[backoff.length - 1];
      console.log(
        `[${retryOptions.logLabel}] Attempt ${i + 1}/${attempts} failed (HTTP ${res.status}); retrying in ${delay}ms...`,
      );
      await sleep(delay);
    } else {
      return res;
    }
  }
  throw new Error("fetchWithRetry: exhausted attempts");
}

interface SyncJsonOptions<T> {
  /** Destination file URL. Parent directory is created if missing. */
  writeTo: URL;
  /** Fetches the upstream payload and projects it to the final entries. */
  parse: () => Promise<readonly T[]>;
  /** Set false for a fetch-and-validate dry run. */
  write?: boolean;
}

/**
 * Boilerplate writer: run `parse()`, mkdir the destination directory, write
 * pretty JSON with a trailing newline, return the entries plus the resolved
 * filesystem path so callers can log or inspect.
 */
export async function syncJson<T>(
  options: SyncJsonOptions<T>,
): Promise<{ entries: readonly T[]; outputFile: string; written: boolean }> {
  const { writeTo, parse, write = true } = options;
  const entries = await parse();
  const outputFile = fileURLToPath(writeTo);
  if (write) {
    mkdirSync(new URL(".", writeTo), { recursive: true });
    writeFileSync(outputFile, JSON.stringify(entries, null, 2) + "\n");
  }
  return { entries, outputFile, written: write };
}

/**
 * Unified env-var priority order for the static-export generator scripts that
 * fetch from a Pharos API base (generate-homepage-bootstrap, generate-public-
 * datasets). Both consult the same ordered list so a configured DIGEST_API_URL
 * (or any shared fallback) is honoured regardless of which generator runs.
 */
export const GENERATOR_API_URL_ENV_NAMES = [
  "HOMEPAGE_BOOTSTRAP_API_URL",
  "DIGEST_API_URL",
  "PUBLIC_DATASETS_API_URL",
  "SMOKE_API_BASE",
  "API_BASE_URL",
] as const;

export const GENERATOR_API_KEY_ENV_NAMES = [
  "HOMEPAGE_BOOTSTRAP_API_KEY",
  "DIGEST_API_KEY",
  "PUBLIC_DATASETS_API_KEY",
  "SMOKE_API_KEY",
  "PHAROS_API_KEY",
] as const;

/**
 * Resolve an API base from the first non-empty value among `envNames`, with the
 * trailing slash trimmed. Returns null when none are configured (callers decide
 * whether that is fatal). Unlike `resolveApiUrl`, this does not throw.
 */
export function resolveApiBaseFromEnv(envNames: readonly string[]): string | null {
  const raw = envNames.map((name) => process.env[name]?.trim()).find((value) => value);
  return raw ? raw.replace(/\/+$/, "") : null;
}

/**
 * Build request headers (`Accept` + optional `X-API-Key`) from the first
 * non-empty API key among `envNames`.
 */
export function apiFetchHeaders(envNames: readonly string[]): Record<string, string> {
  const apiKey = envNames.map((name) => process.env[name]?.trim()).find((value) => value);
  const siteApiSharedSecret = process.env.SITE_API_SHARED_SECRET?.trim();
  return {
    Accept: "application/json",
    ...(apiKey ? { "X-API-Key": apiKey } : {}),
    ...(siteApiSharedSecret ? { [SITE_DATA_PROXY_SECRET_HEADER]: siteApiSharedSecret } : {}),
  };
}

/**
 * Convenience wrapper used by both generator scripts (generate-public-datasets
 * and generate-homepage-bootstrap). Resolves from GENERATOR_API_URL_ENV_NAMES.
 */
export function resolveGeneratorApiBase(): string | null {
  return resolveApiBaseFromEnv(GENERATOR_API_URL_ENV_NAMES);
}

/**
 * Convenience wrapper used by both generator scripts. Builds fetch headers
 * from GENERATOR_API_KEY_ENV_NAMES.
 */
export function generatorFetchHeaders(): Record<string, string> {
  return apiFetchHeaders(GENERATOR_API_KEY_ENV_NAMES);
}
