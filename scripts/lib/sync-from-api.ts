/**
 * Shared helpers for `sync-*.ts` maintenance scripts that pull a snapshot
 * from a Pharos API endpoint and write a JSON mirror under `data/`.
 *
 * Extracts the URL-resolution, timestamp formatting, and file-write
 * boilerplate common to sync-digests.ts and sync-depeg-events.ts.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getArgValue, sleep } from "./cli.mjs";

interface ResolveApiUrlOptions {
  /** CLI flag that overrides everything else, e.g. `--api-url`. */
  argName: string;
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
  const { argName, envNames, apiPath, scriptName } = options;
  const explicit =
    getArgValue(process.argv, argName) ??
    envNames.map((name) => process.env[name]).find((value) => value != null && value !== "") ??
    null;
  if (!explicit) {
    throw new Error(
      `Provide ${argName} or set ${envNames.join(" / ")} before running ${scriptName}.`,
    );
  }
  if (explicit.endsWith(apiPath)) return explicit;
  return `${explicit.replace(/\/+$/, "")}${apiPath}`;
}

/**
 * Convert a UNIX epoch in seconds to an ISO date (`YYYY-MM-DD`).
 */
export function tsToDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

interface FetchWithRetryOptions {
  /** Label used in retry logs, without surrounding brackets. */
  logLabel: string;
  attempts?: number;
  backoffMs?: readonly number[];
}

export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retryOptions: FetchWithRetryOptions,
): Promise<Response> {
  const attempts = retryOptions.attempts ?? 3;
  const backoff = retryOptions.backoffMs ?? [1000, 2000];
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
    if (res.ok || res.status < 500) return res;
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
}

/**
 * Boilerplate writer: run `parse()`, mkdir the destination directory, write
 * pretty JSON with a trailing newline, return the entries plus the resolved
 * filesystem path so callers can log or inspect.
 */
export async function syncJson<T>(
  options: SyncJsonOptions<T>,
): Promise<{ entries: readonly T[]; outputFile: string }> {
  const { writeTo, parse } = options;
  const entries = await parse();
  const outputFile = fileURLToPath(writeTo);
  mkdirSync(new URL(".", writeTo), { recursive: true });
  writeFileSync(outputFile, JSON.stringify(entries, null, 2) + "\n");
  return { entries, outputFile };
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
  return {
    Accept: "application/json",
    ...(apiKey ? { "X-API-Key": apiKey } : {}),
  };
}
